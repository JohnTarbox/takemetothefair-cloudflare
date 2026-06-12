/**
 * J2 / C1 — admin_actions mining card: "Automation candidates".
 *
 * Mines the operator-activity log (admin_actions) to produce a ranked,
 * evidence-backed view of where engineering should automate next. Design +
 * data rationale: docs/j2-admin-actions-mining-card-brief.md.
 *
 * Three v1 metrics, each a single-pass query over indexed columns:
 *   M-B  Source reject-rate     — where auto-ingest produces junk
 *   M-C  Vendor-link clusters   — biggest batch-UI win
 *   M-A  Field-correction hotspots — which fields the extractor gets wrong
 *
 * Server-rendered, edge runtime, no client interactivity. Same conventions
 * as /admin/source-quality.
 */
import Link from "next/link";
import { eq, inArray, sql, desc } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { getCloudflareDb } from "@/lib/cloudflare";
import { adminActions, events, eventDataCitations } from "@/lib/db/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const revalidate = 300; // 5-min ISR — operator activity doesn't churn fast.

const MIN_REVIEWS_FOR_RATE = 5; // don't let a 1-event source read as 100% reject.
const MIN_CLUSTER_SIZE = 3; // a "burst" worth a batch UI is ≥3 links in a day.

// ── M-B: source / promoter reject-rate ─────────────────────────────────────

interface SourceRejectRow {
  source: string;
  approved: number;
  rejected: number;
  total: number;
  rejectRate: number;
  rejectedSlugs: string[];
}

async function loadSourceRejectRate(): Promise<SourceRejectRow[]> {
  const db = getCloudflareDb();
  // Every TENTATIVE→APPROVED / →REJECTED transition, joined to its event's
  // source. new_status lives in the action payload; the event carries the
  // source. Bounded (~hundreds of status_change rows) → aggregate in JS.
  const rows = await db
    .select({
      sourceName: events.sourceName,
      sourceDomain: events.sourceDomain,
      slug: events.slug,
      newStatus: sql<string>`json_extract(${adminActions.payloadJson}, '$.new_status')`,
    })
    .from(adminActions)
    .innerJoin(events, eq(events.id, adminActions.targetId))
    .where(eq(adminActions.action, "event.status_change"));

  const bySource = new Map<
    string,
    { approved: number; rejected: number; rejectedSlugs: string[] }
  >();
  for (const r of rows) {
    const key = r.sourceDomain || r.sourceName || "(unknown source)";
    const b = bySource.get(key) ?? { approved: 0, rejected: 0, rejectedSlugs: [] };
    if (r.newStatus === "APPROVED") b.approved++;
    else if (r.newStatus === "REJECTED") {
      b.rejected++;
      if (b.rejectedSlugs.length < 5 && r.slug) b.rejectedSlugs.push(r.slug);
    }
    bySource.set(key, b);
  }

  return [...bySource.entries()]
    .map(([source, b]) => {
      const total = b.approved + b.rejected;
      return { source, ...b, total, rejectRate: total ? b.rejected / total : 0 };
    })
    .filter((r) => r.total >= MIN_REVIEWS_FOR_RATE)
    .sort((a, b) => b.rejectRate - a.rejectRate || b.total - a.total)
    .slice(0, 15);
}

// ── M-C: vendor-link batch clusters ────────────────────────────────────────

interface ClusterRow {
  eventId: string;
  eventName: string | null;
  eventSlug: string | null;
  actor: string | null;
  day: string;
  n: number;
}

async function loadVendorLinkClusters(): Promise<ClusterRow[]> {
  const db = getCloudflareDb();
  // Bucket vendor-link actions by (event, actor, calendar day). A large bucket
  // = many vendors added to one event in one sitting = a multi-select "add N
  // vendors" UI would have saved that many round-trips. event_id is in the
  // payload; created_at is unix seconds.
  const eventIdExpr = sql<string>`json_extract(${adminActions.payloadJson}, '$.event_id')`;
  const dayExpr = sql<string>`date(${adminActions.createdAt}, 'unixepoch')`;
  const rows = await db
    .select({
      eventId: eventIdExpr,
      actor: adminActions.actorUserId,
      day: dayExpr,
      n: sql<number>`COUNT(*)`,
    })
    .from(adminActions)
    .where(inArray(adminActions.action, ["event_vendor.create_or_link", "event_vendor.create"]))
    .groupBy(eventIdExpr, adminActions.actorUserId, dayExpr)
    .having(sql`COUNT(*) >= ${MIN_CLUSTER_SIZE}`)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(15);

  const ids = [...new Set(rows.map((r) => r.eventId).filter(Boolean))];
  const nameById = new Map<string, { name: string; slug: string }>();
  if (ids.length > 0) {
    const evs = await db
      .select({ id: events.id, name: events.name, slug: events.slug })
      .from(events)
      .where(inArray(events.id, ids));
    for (const e of evs) nameById.set(e.id, { name: e.name, slug: e.slug });
  }

  return rows.map((r) => {
    const ev = r.eventId ? nameById.get(r.eventId) : undefined;
    return {
      eventId: r.eventId,
      eventName: ev?.name ?? null,
      eventSlug: ev?.slug ?? null,
      actor: r.actor,
      day: r.day,
      n: Number(r.n),
    };
  });
}

// ── M-A: field-correction hotspots ─────────────────────────────────────────

interface FieldHotspots {
  citations: Array<{ field: string; n: number }>;
  edits: Array<{ field: string; n: number }>;
  editTotal: number;
}

async function loadFieldHotspots(): Promise<FieldHotspots> {
  const db = getCloudflareDb();
  // v1 proxy: which fields carry the most source citations (= most often
  // supplemented after auto-ingest).
  const cites = await db
    .select({ field: eventDataCitations.fieldName, n: sql<number>`COUNT(*)` })
    .from(eventDataCitations)
    .groupBy(eventDataCitations.fieldName)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(15);

  // First-class signal: operator field edits logged as event.update (J2
  // instrumentation, PR #459). The `fields` array can't be GROUP BY'd in SQL,
  // so fetch + flatten in JS. Empty until the instrumentation deploys and edits
  // accrue — that's expected.
  const updateRows = await db
    .select({ payload: adminActions.payloadJson })
    .from(adminActions)
    .where(eq(adminActions.action, "event.update"));

  const fieldCounts = new Map<string, number>();
  for (const u of updateRows) {
    try {
      const parsed = JSON.parse(u.payload ?? "{}") as { fields?: unknown };
      if (Array.isArray(parsed.fields)) {
        for (const f of parsed.fields) {
          if (typeof f === "string") fieldCounts.set(f, (fieldCounts.get(f) ?? 0) + 1);
        }
      }
    } catch {
      // skip malformed payloads
    }
  }

  return {
    citations: cites.map((c) => ({ field: c.field, n: Number(c.n) })),
    edits: [...fieldCounts.entries()]
      .map(([field, n]) => ({ field, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 15),
    editTotal: updateRows.length,
  };
}

// ── Render ──────────────────────────────────────────────────────────────────

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export default async function AutomationCandidatesPage() {
  const [sources, clusters, fields] = await Promise.all([
    loadSourceRejectRate(),
    loadVendorLinkClusters(),
    loadFieldHotspots(),
  ]);

  return (
    <div className="max-w-7xl space-y-6 p-4">
      <div>
        <Link
          href="/admin/analytics"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-2"
        >
          <ArrowLeft className="w-4 h-4 mr-1" aria-hidden="true" />
          Back to Analytics
        </Link>
        <h1 className="text-2xl font-bold text-foreground">Automation candidates</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Mined from <code>admin_actions</code> — where to point engineering next. See{" "}
          <code>docs/j2-admin-actions-mining-card-brief.md</code> for the metric definitions.
        </p>
      </div>

      {/* M-B */}
      <Card>
        <CardHeader>
          <CardTitle>Source reject-rate — where auto-ingest is weakest</CardTitle>
          <p className="text-sm text-muted-foreground">
            % of reviewed events rejected per source (≥{MIN_REVIEWS_FOR_RATE} reviews). High = the
            extractor/source produces junk; candidate to down-weight or gate.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-muted border-b border-border text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Source</th>
                  <th className="px-4 py-2 font-medium text-right">Reject %</th>
                  <th className="px-4 py-2 font-medium text-right">Rejected</th>
                  <th className="px-4 py-2 font-medium text-right">Reviewed</th>
                  <th className="px-4 py-2 font-medium">Example rejected slugs</th>
                </tr>
              </thead>
              <tbody>
                {sources.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                      No source has ≥{MIN_REVIEWS_FOR_RATE} reviewed events yet.
                    </td>
                  </tr>
                ) : (
                  sources.map((r) => (
                    <tr key={r.source} className="border-b border-border hover:bg-muted">
                      <td className="px-4 py-2 font-mono text-xs text-foreground">{r.source}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium">
                        <span className={r.rejectRate >= 0.5 ? "text-red-600" : "text-foreground"}>
                          {pct(r.rejectRate)}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-foreground">
                        {r.rejected}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                        {r.total}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {r.rejectedSlugs.join(", ") || "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* M-C */}
      <Card>
        <CardHeader>
          <CardTitle>Vendor-link bursts — biggest batch-UI win</CardTitle>
          <p className="text-sm text-muted-foreground">
            Events where one operator linked ≥{MIN_CLUSTER_SIZE} vendors in a day. The largest
            bursts are the clearest candidates for a multi-select &quot;add N vendors&quot; flow.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-muted border-b border-border text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Event</th>
                  <th className="px-4 py-2 font-medium text-right">Vendors linked</th>
                  <th className="px-4 py-2 font-medium">Day</th>
                </tr>
              </thead>
              <tbody>
                {clusters.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">
                      No vendor-link bursts of ≥{MIN_CLUSTER_SIZE} yet.
                    </td>
                  </tr>
                ) : (
                  clusters.map((c, i) => (
                    <tr
                      key={`${c.eventId}-${c.day}-${i}`}
                      className="border-b border-border hover:bg-muted"
                    >
                      <td className="px-4 py-2">
                        {c.eventSlug ? (
                          <Link
                            href={`/admin/events/${c.eventId}/vendors`}
                            className="text-royal hover:underline"
                          >
                            {c.eventName ?? c.eventSlug}
                          </Link>
                        ) : (
                          <span className="font-mono text-xs text-muted-foreground">
                            {c.eventId || "(no event_id)"}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium text-foreground">
                        {c.n}
                      </td>
                      <td className="px-4 py-2 tabular-nums text-muted-foreground">{c.day}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* M-A */}
      <Card>
        <CardHeader>
          <CardTitle>Field-correction hotspots — which fields the extractor gets wrong</CardTitle>
          <p className="text-sm text-muted-foreground">
            Operator field edits (<code>event.update</code>, {fields.editTotal} logged) are the
            first-class signal; source citations are the v1 proxy until edits accrue.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-foreground mb-2">
                Operator edits (event.update)
              </h3>
              {fields.edits.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No <code>event.update</code> rows yet — accrues once the J2 instrumentation
                  deploys and operators edit events.
                </p>
              ) : (
                <ul className="text-sm divide-y divide-border">
                  {fields.edits.map((f) => (
                    <li key={f.field} className="flex justify-between py-1.5">
                      <span className="font-mono text-xs">{f.field}</span>
                      <span className="tabular-nums font-medium">{f.n}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground mb-2">
                Source citations (proxy)
              </h3>
              {fields.citations.length === 0 ? (
                <p className="text-sm text-muted-foreground">No citations recorded.</p>
              ) : (
                <ul className="text-sm divide-y divide-border">
                  {fields.citations.map((f) => (
                    <li key={f.field} className="flex justify-between py-1.5">
                      <span className="font-mono text-xs">{f.field}</span>
                      <span className="tabular-nums font-medium">{f.n}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
