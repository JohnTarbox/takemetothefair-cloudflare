/**
 * Per-source quality dashboard — the payoff from PR #247's source split.
 *
 * GROUP BY source_domain + ingestion_method on events to surface the
 * signals the analyst's original 2026-05-26 spec was after:
 *   - rejection rate (fraction of events the admin REJECTED)
 *   - cancellation rate (fraction marked CANCELLED post-approval)
 *   - gate-flag rate (fraction held in PENDING with gate_flags set)
 *   - unresolved drift rate (open event_date_drift_findings per source)
 *   - imageless rate (rough enrichment-completeness signal)
 *
 * Sorted by a composite "concern" score so the worst sources surface
 * first. Click a source_domain to filter the admin events table to
 * that source for triage.
 *
 * Server-rendered, edge runtime. No client interactivity beyond
 * filter-by-ingestion-method via query string.
 */

import Link from "next/link";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, eventDateDriftFindings, inboundEmails } from "@/lib/db/schema";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const runtime = "edge";
export const revalidate = 300; // 5-min ISR — these numbers don't churn fast

// Sources with fewer than this many total events are too small to score
// meaningfully. Filtering them keeps the table focused on the high-volume
// long tail where reliability scoring actually matters.
const MIN_EVENTS_FOR_SCORING = 3;

interface SourceRow {
  sourceDomain: string | null;
  ingestionMethod: string | null;
  total: number;
  rejected: number;
  cancelled: number;
  gateFlagged: number;
  imageless: number;
  unresolvedDrift: number;
  // Composite concern score: percentage of events that show ANY quality
  // issue. Used for sort order; higher = worse.
  concernPct: number;
}

async function loadSourceQuality(filterMethod: string | null): Promise<SourceRow[]> {
  const db = getCloudflareDb();
  // Note: SQLite GROUP BY with multiple aggregates in one pass. CASE-WHEN
  // sums are the standard pattern when the dataset is small enough that
  // pivoting in app code beats writing 5 separate queries.
  const baseRows = await db
    .select({
      sourceDomain: events.sourceDomain,
      ingestionMethod: events.ingestionMethod,
      total: sql<number>`COUNT(*)`,
      rejected: sql<number>`SUM(CASE WHEN ${events.status} = 'REJECTED' THEN 1 ELSE 0 END)`,
      cancelled: sql<number>`SUM(CASE WHEN ${events.status} = 'CANCELLED' THEN 1 ELSE 0 END)`,
      gateFlagged: sql<number>`SUM(CASE WHEN ${events.status} = 'PENDING' AND ${events.gateFlags} IS NOT NULL THEN 1 ELSE 0 END)`,
      imageless: sql<number>`SUM(CASE WHEN ${events.imageUrl} IS NULL OR ${events.imageUrl} = '' THEN 1 ELSE 0 END)`,
    })
    .from(events)
    .where(isNotNull(events.ingestionMethod))
    .groupBy(events.sourceDomain, events.ingestionMethod);

  // Separate query for unresolved drift findings — join would over-count
  // events that have multiple findings, and a subquery in the SELECT is
  // awkward in Drizzle. Aggregate first, merge in JS.
  const driftRows = await db
    .select({
      sourceDomain: events.sourceDomain,
      ingestionMethod: events.ingestionMethod,
      unresolvedDrift: sql<number>`COUNT(DISTINCT ${eventDateDriftFindings.eventId})`,
    })
    .from(eventDateDriftFindings)
    .innerJoin(events, eq(events.id, eventDateDriftFindings.eventId))
    .where(and(isNull(eventDateDriftFindings.resolvedAt), isNotNull(events.ingestionMethod)))
    .groupBy(events.sourceDomain, events.ingestionMethod);

  const driftByKey = new Map<string, number>();
  for (const r of driftRows) {
    const key = `${r.sourceDomain ?? ""}|${r.ingestionMethod ?? ""}`;
    driftByKey.set(key, r.unresolvedDrift ?? 0);
  }

  const rows: SourceRow[] = baseRows
    .filter((r) => (r.total ?? 0) >= MIN_EVENTS_FOR_SCORING)
    .filter((r) => filterMethod == null || r.ingestionMethod === filterMethod)
    .map((r) => {
      const key = `${r.sourceDomain ?? ""}|${r.ingestionMethod ?? ""}`;
      const total = r.total ?? 0;
      const rejected = r.rejected ?? 0;
      const cancelled = r.cancelled ?? 0;
      const gateFlagged = r.gateFlagged ?? 0;
      const unresolvedDrift = driftByKey.get(key) ?? 0;
      const concerns = rejected + cancelled + gateFlagged + unresolvedDrift;
      const concernPct = total > 0 ? Math.round((concerns / total) * 1000) / 10 : 0;
      return {
        sourceDomain: r.sourceDomain,
        ingestionMethod: r.ingestionMethod,
        total,
        rejected,
        cancelled,
        gateFlagged,
        imageless: r.imageless ?? 0,
        unresolvedDrift,
        concernPct,
      };
    })
    .sort((a, b) => b.concernPct - a.concernPct || b.total - a.total);

  return rows;
}

async function loadOverall(): Promise<{
  totalEvents: number;
  sourcesTracked: number;
  classifiedPct: number;
}> {
  const db = getCloudflareDb();
  const [{ totalEvents = 0 } = { totalEvents: 0 }] = await db
    .select({ totalEvents: sql<number>`COUNT(*)` })
    .from(events);
  const [{ classified = 0 } = { classified: 0 }] = await db
    .select({ classified: sql<number>`COUNT(*)` })
    .from(events)
    .where(isNotNull(events.ingestionMethod));
  const [{ sourcesTracked = 0 } = { sourcesTracked: 0 }] = await db
    .select({
      sourcesTracked: sql<number>`COUNT(DISTINCT ${events.sourceDomain})`,
    })
    .from(events)
    .where(isNotNull(events.sourceDomain));
  return {
    totalEvents: totalEvents ?? 0,
    sourcesTracked: sourcesTracked ?? 0,
    classifiedPct:
      (totalEvents ?? 0) > 0 ? Math.round(((classified ?? 0) / (totalEvents ?? 1)) * 1000) / 10 : 0,
  };
}

const METHOD_OPTIONS: Array<{ value: string | null; label: string }> = [
  { value: null, label: "All methods" },
  { value: "direct_scrape", label: "direct_scrape" },
  { value: "aggregator_import", label: "aggregator_import" },
  { value: "vendor_submission", label: "vendor_submission" },
  { value: "email_submission", label: "email_submission" },
  { value: "community_suggestion", label: "community_suggestion" },
  { value: "admin_manual", label: "admin_manual" },
  { value: "web_research", label: "web_research" },
];

export default async function SourceQualityPage({
  searchParams,
}: {
  searchParams: Promise<{ method?: string }>;
}) {
  const params = await searchParams;
  const filterMethod = params.method && params.method !== "all" ? params.method : null;

  const [rows, overall] = await Promise.all([loadSourceQuality(filterMethod), loadOverall()]);

  return (
    <div className="max-w-7xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Per-source quality</h1>
        <p className="text-sm text-gray-600 mt-1">
          Reliability metrics grouped by <code>source_domain</code> + <code>ingestion_method</code>{" "}
          (the columns shipped in PR #247). Sources with fewer than {MIN_EVENTS_FOR_SCORING} events
          are filtered out. Sorted by composite concern % (highest first).
        </p>
      </header>

      <Card>
        <CardContent>
          <div className="flex flex-wrap items-center gap-6 py-2">
            <Stat label="Total events" value={overall.totalEvents} />
            <Stat label="Sources tracked" value={overall.sourcesTracked} />
            <Stat label="Classified %" value={overall.classifiedPct} suffix="%" />
            <Stat label="Sources shown" value={rows.length} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <h2 className="font-semibold text-gray-900">Filter</h2>
            <nav className="flex flex-wrap gap-1 text-xs">
              {METHOD_OPTIONS.map((opt) => {
                const active = (opt.value ?? "all") === (filterMethod ?? "all");
                const href = opt.value
                  ? `/admin/source-quality?method=${opt.value}`
                  : "/admin/source-quality";
                return (
                  <Link
                    key={opt.label}
                    href={href}
                    className={`px-3 py-1 rounded ${
                      active ? "bg-navy text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                    }`}
                  >
                    {opt.label}
                  </Link>
                );
              })}
            </nav>
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200 text-left text-gray-600">
                <tr>
                  <th className="px-4 py-2 font-medium">source_domain</th>
                  <th className="px-4 py-2 font-medium">method</th>
                  <th className="px-4 py-2 font-medium text-right">total</th>
                  <th className="px-4 py-2 font-medium text-right">rejected</th>
                  <th className="px-4 py-2 font-medium text-right">cancelled</th>
                  <th className="px-4 py-2 font-medium text-right">flagged</th>
                  <th className="px-4 py-2 font-medium text-right">drift</th>
                  <th className="px-4 py-2 font-medium text-right">imageless</th>
                  <th className="px-4 py-2 font-medium text-right">concern</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={`${r.sourceDomain ?? ""}|${r.ingestionMethod ?? ""}`}
                    className="border-b border-gray-100 hover:bg-gray-50"
                  >
                    <td className="px-4 py-2 font-mono text-gray-900">
                      {r.sourceDomain ? (
                        <Link
                          href={`/admin/events?source=${encodeURIComponent(r.sourceDomain)}`}
                          className="text-blue-600 hover:underline"
                        >
                          {r.sourceDomain}
                        </Link>
                      ) : (
                        <span className="text-gray-400">(no domain)</span>
                      )}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-700">
                      {r.ingestionMethod}
                    </td>
                    <Num value={r.total} />
                    <Num value={r.rejected} pct={pct(r.rejected, r.total)} />
                    <Num value={r.cancelled} pct={pct(r.cancelled, r.total)} />
                    <Num value={r.gateFlagged} pct={pct(r.gateFlagged, r.total)} />
                    <Num value={r.unresolvedDrift} pct={pct(r.unresolvedDrift, r.total)} />
                    <Num value={r.imageless} pct={pct(r.imageless, r.total)} muted />
                    <td className="px-4 py-2 text-right">
                      <ConcernBadge pct={r.concernPct} />
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                      No sources match the current filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <ExtractionMethodCard />

      <p className="text-xs text-gray-500">
        Concern % = (rejected + cancelled + gate-flagged + unresolved-drift) / total. Imageless rate
        shown separately — it&apos;s a coverage gap, not a quality flag.
      </p>
    </div>
  );
}

/**
 * Analyst A2 (2026-05-29) — per-source extraction_method breakdown.
 *
 * Distinguishes "extractor failing on a good source" from "low-quality
 * source" by surfacing which extraction strategy actually produced
 * each event. Today this data only exists for email submissions
 * (inbound_emails.extraction_method, drizzle/0083); direct_scrape /
 * url_import / community_suggestion paths don't persist the strategy
 * at the row level, so they're out of scope here.
 *
 * Joined via inbound_emails.resulting_event_id → events.id so we can
 * group by the event's source_domain (the row the page already
 * surfaces in the main table). One pass, one GROUP BY.
 */
interface ExtractionRow {
  sourceDomain: string | null;
  extractionMethod: string | null;
  count: number;
}

async function loadExtractionMix(): Promise<ExtractionRow[]> {
  const db = getCloudflareDb();
  const rows = await db
    .select({
      sourceDomain: events.sourceDomain,
      extractionMethod: inboundEmails.extractionMethod,
      count: sql<number>`COUNT(*)`,
    })
    .from(inboundEmails)
    .innerJoin(events, eq(events.id, inboundEmails.resultingEventId))
    .where(and(isNotNull(inboundEmails.extractionMethod), isNotNull(events.sourceDomain)))
    .groupBy(events.sourceDomain, inboundEmails.extractionMethod);
  return rows.map((r) => ({
    sourceDomain: r.sourceDomain,
    extractionMethod: r.extractionMethod,
    count: Number(r.count ?? 0),
  }));
}

async function ExtractionMethodCard() {
  const rows = await loadExtractionMix();

  // Pivot to one entry per source_domain with a method→count map.
  interface PivotRow {
    sourceDomain: string | null;
    total: number;
    methods: Record<string, number>;
  }
  const pivotMap = new Map<string, PivotRow>();
  const methodTotals = new Map<string, number>();
  for (const r of rows) {
    const key = r.sourceDomain ?? "(no domain)";
    const method = r.extractionMethod ?? "(none)";
    const existing = pivotMap.get(key) ?? {
      sourceDomain: r.sourceDomain,
      total: 0,
      methods: {},
    };
    existing.methods[method] = (existing.methods[method] ?? 0) + r.count;
    existing.total += r.count;
    pivotMap.set(key, existing);
    methodTotals.set(method, (methodTotals.get(method) ?? 0) + r.count);
  }
  const pivoted = [...pivotMap.values()].sort((a, b) => b.total - a.total);

  // Column order — most common method first so the eye sweeps the
  // hottest path. Falls back to alphabetical for ties.
  const methodColumns = [...methodTotals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => k);

  return (
    <Card>
      <CardHeader>
        <h2 className="font-semibold text-gray-900">
          Email-submission extractor mix
          <span className="ml-2 text-xs font-normal text-gray-500">
            (inbound_emails only — other ingestion paths don&apos;t persist extraction_method per
            row)
          </span>
        </h2>
      </CardHeader>
      <CardContent className="p-0">
        {pivoted.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-500">
            No email submissions with a recorded extraction method yet. Submit one to
            <code>submit@meetmeatthefair.com</code> and rerun the dashboard.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200 text-left text-gray-600">
                <tr>
                  <th className="px-4 py-2 font-medium">source_domain</th>
                  {methodColumns.map((m) => (
                    <th key={m} className="px-4 py-2 font-medium text-right font-mono text-xs">
                      {m}
                    </th>
                  ))}
                  <th className="px-4 py-2 font-medium text-right">total</th>
                </tr>
              </thead>
              <tbody>
                {pivoted.map((r) => (
                  <tr
                    key={r.sourceDomain ?? "(no domain)"}
                    className="border-b border-gray-100 hover:bg-gray-50"
                  >
                    <td className="px-4 py-2 font-mono text-gray-900">
                      {r.sourceDomain ?? <span className="text-gray-400">(no domain)</span>}
                    </td>
                    {methodColumns.map((m) => (
                      <td key={m} className="px-4 py-2 text-right tabular-nums text-gray-700">
                        {r.methods[m] ?? 0}
                      </td>
                    ))}
                    <td className="px-4 py-2 text-right tabular-nums font-medium text-gray-900">
                      {r.total}
                    </td>
                  </tr>
                ))}
                {/* Totals row — helps distinguish a 10-event source with
                    50% json-ld from a 100-event source with 5%. */}
                <tr className="bg-gray-50 border-t border-gray-300 font-medium">
                  <td className="px-4 py-2 text-gray-700">total</td>
                  {methodColumns.map((m) => (
                    <td key={m} className="px-4 py-2 text-right tabular-nums text-gray-900">
                      {methodTotals.get(m) ?? 0}
                    </td>
                  ))}
                  <td className="px-4 py-2 text-right tabular-nums text-gray-900">
                    {[...methodTotals.values()].reduce((a, b) => a + b, 0)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, suffix }: { label: string; value: number; suffix?: string }) {
  return (
    <div>
      <p className="text-2xl font-bold text-gray-900 tabular-nums">
        {value.toLocaleString()}
        {suffix}
      </p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  );
}

function pct(n: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((n / total) * 1000) / 10;
}

function Num({ value, pct, muted }: { value: number; pct?: number; muted?: boolean }) {
  return (
    <td
      className={`px-4 py-2 text-right tabular-nums ${muted ? "text-gray-500" : "text-gray-900"}`}
    >
      {value.toLocaleString()}
      {pct != null && pct > 0 && <span className="ml-1 text-xs text-gray-500">({pct}%)</span>}
    </td>
  );
}

function ConcernBadge({ pct }: { pct: number }) {
  if (pct >= 30) return <Badge variant="danger">{pct}%</Badge>;
  if (pct >= 15) return <Badge variant="warning">{pct}%</Badge>;
  if (pct > 0) return <Badge variant="info">{pct}%</Badge>;
  return <Badge variant="success">{pct}%</Badge>;
}
