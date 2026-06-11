/**
 * Per-promoter quality dashboard — analyst J5 (2026-05-29 PM).
 *
 * Structural fork of /admin/source-quality (PR #252): same Stat /
 * ConcernBadge components, same JS-side merge pattern, same edge-runtime
 * + 5-min ISR cache. Differences:
 *
 *   GROUP BY     promoter_id (not source_domain + ingestion_method)
 *   Concerns     rejected + cancelled (from lifecycleStatus) + gate_flagged
 *                + drift + imageless
 *   Lifecycle    CANCELLED + POSTPONED rates (new dimension; source-
 *                quality has no equivalent because sources don't have
 *                lifecycle states)
 *   Tier         explicit T1 / T2 / T3 classification, not implicit via
 *                concern %. Sets up tier-aware auto-approval as the
 *                analyst-noted downstream payoff.
 *
 * Tier classification is per-promoter so a downstream auto-approval
 * pipeline can read promoter.tier=T1 → auto-approve without admin
 * review, T2 → admin reviews, T3 → admin reviews + extra scrutiny.
 * This page just surfaces the tier in v1; tier-aware approval is a
 * separate follow-up that touches the suggest-event submit pipeline.
 */

import Link from "next/link";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, eventDateDriftFindings, promoters } from "@/lib/db/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const revalidate = 300;

// Promoters with fewer than this many events default to T2 (watch) —
// not enough signal to either trust (T1) or flag (T3). Same default
// philosophy as the source-quality MIN_EVENTS_FOR_SCORING gate, but the
// promoter page surfaces them rather than dropping (the operator wants
// to see all promoters, just with the right tier).
const MIN_EVENTS_FOR_TIER = 3;

type Tier = "T1" | "T2" | "T3";

interface PromoterRow {
  promoterId: string;
  promoterName: string;
  promoterSlug: string;
  total: number;
  rejected: number;
  cancelled: number;
  postponed: number;
  gateFlagged: number;
  imageless: number;
  unresolvedDrift: number;
  avgCompleteness: number;
  concernPct: number;
  tier: Tier;
}

function classifyTier(concernPct: number, total: number): Tier {
  // Too small to score → default watch (T2). Operators can still see
  // the row but auto-approval shouldn't trust a tiny sample as T1.
  if (total < MIN_EVENTS_FOR_TIER) return "T2";
  // Tier thresholds picked so a promoter with 10% concern (occasional
  // cancellation, occasional gate flag) lands T2, and >25% concern
  // (regular reliability problem) lands T3. Tunable as data accumulates.
  if (concernPct >= 25) return "T3";
  if (concernPct >= 10) return "T2";
  return "T1";
}

async function loadPromoterQuality(): Promise<PromoterRow[]> {
  const db = getCloudflareDb();

  // Pass 1: per-promoter counts. Single GROUP BY with CASE-WHEN sums,
  // same pattern as source-quality. CANCELLED + POSTPONED come from
  // lifecycle_status (not events.status which is the editorial state)
  // — that's the post-approval lifecycle dimension promoters most-
  // visibly drive.
  const baseRows = await db
    .select({
      promoterId: events.promoterId,
      promoterName: promoters.companyName,
      promoterSlug: promoters.slug,
      total: sql<number>`COUNT(*)`,
      rejected: sql<number>`SUM(CASE WHEN ${events.status} = 'REJECTED' THEN 1 ELSE 0 END)`,
      cancelled: sql<number>`SUM(CASE WHEN ${events.lifecycleStatus} = 'CANCELLED' THEN 1 ELSE 0 END)`,
      postponed: sql<number>`SUM(CASE WHEN ${events.lifecycleStatus} = 'POSTPONED' THEN 1 ELSE 0 END)`,
      gateFlagged: sql<number>`SUM(CASE WHEN ${events.status} = 'PENDING' AND ${events.gateFlags} IS NOT NULL THEN 1 ELSE 0 END)`,
      imageless: sql<number>`SUM(CASE WHEN ${events.imageUrl} IS NULL OR ${events.imageUrl} = '' THEN 1 ELSE 0 END)`,
      avgCompleteness: sql<number>`AVG(${events.completenessScore})`,
    })
    .from(events)
    .innerJoin(promoters, eq(promoters.id, events.promoterId))
    .where(isNotNull(events.promoterId))
    .groupBy(events.promoterId, promoters.companyName, promoters.slug);

  // Pass 2: per-promoter unresolved drift. Same pattern as source-
  // quality's driftRows query; JOIN on events.promoterId.
  const driftRows = await db
    .select({
      promoterId: events.promoterId,
      unresolvedDrift: sql<number>`COUNT(DISTINCT ${eventDateDriftFindings.eventId})`,
    })
    .from(eventDateDriftFindings)
    .innerJoin(events, eq(events.id, eventDateDriftFindings.eventId))
    .where(and(isNull(eventDateDriftFindings.resolvedAt), isNotNull(events.promoterId)))
    .groupBy(events.promoterId);
  const driftByPromoter = new Map<string, number>();
  for (const r of driftRows) {
    if (!r.promoterId) continue;
    driftByPromoter.set(r.promoterId, Number(r.unresolvedDrift ?? 0));
  }

  const rows: PromoterRow[] = baseRows
    .filter((r) => r.promoterId != null)
    .map((r) => {
      const promoterId = r.promoterId!;
      const total = Number(r.total ?? 0);
      const rejected = Number(r.rejected ?? 0);
      const cancelled = Number(r.cancelled ?? 0);
      const postponed = Number(r.postponed ?? 0);
      const gateFlagged = Number(r.gateFlagged ?? 0);
      const imageless = Number(r.imageless ?? 0);
      const unresolvedDrift = driftByPromoter.get(promoterId) ?? 0;
      // Same concern formula as source-quality except adding postponed.
      // CANCELLED is a hard reliability failure; POSTPONED is softer
      // (the event will still happen, just later) but it's still a
      // signal the operator wants to weight.
      const concerns = rejected + cancelled + postponed + gateFlagged + unresolvedDrift;
      const concernPct = total > 0 ? Math.round((concerns / total) * 1000) / 10 : 0;
      return {
        promoterId,
        promoterName: r.promoterName ?? "(unnamed promoter)",
        promoterSlug: r.promoterSlug as unknown as string,
        total,
        rejected,
        cancelled,
        postponed,
        gateFlagged,
        imageless,
        unresolvedDrift,
        avgCompleteness: Math.round(Number(r.avgCompleteness ?? 0)),
        concernPct,
        tier: classifyTier(concernPct, total),
      };
    })
    // Sort: T3 first (action target), then T2, then T1; within each
    // tier, highest concern % first; within concern %, highest total
    // first. Same priority logic as the source-quality page.
    .sort((a, b) => {
      const tierOrder = (t: Tier) => (t === "T3" ? 0 : t === "T2" ? 1 : 2);
      if (a.tier !== b.tier) return tierOrder(a.tier) - tierOrder(b.tier);
      if (a.concernPct !== b.concernPct) return b.concernPct - a.concernPct;
      return b.total - a.total;
    });

  return rows;
}

export const dynamic = "force-dynamic";

export default async function PromoterQualityPage() {
  const rows = await loadPromoterQuality();
  const tierCounts = rows.reduce(
    (acc, r) => {
      acc[r.tier]++;
      return acc;
    },
    { T1: 0, T2: 0, T3: 0 } as Record<Tier, number>
  );

  return (
    <div className="max-w-7xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-foreground">Per-promoter quality</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Reliability metrics grouped by promoter. Composite concern % combines rejection,
          cancellation (post-approval lifecycle), postponement, gate-flag, and unresolved-drift
          rates. Tier classification gates downstream auto-approval scrutiny — T1 = clean, T2 =
          watch, T3 = risky. Forked from <code>/admin/source-quality</code> (PR #252) per analyst J5
          (2026-05-29 PM).
        </p>
      </header>

      <Card>
        <CardContent>
          <div className="flex flex-wrap items-center gap-6 py-2">
            <TierStat label="T1 clean" value={tierCounts.T1} tier="T1" />
            <TierStat label="T2 watch" value={tierCounts.T2} tier="T2" />
            <TierStat label="T3 risky" value={tierCounts.T3} tier="T3" />
            <TierStat label="Total tracked" value={rows.length} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Promoters</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No promoters tracked yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-muted border-b border-border text-left text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">promoter</th>
                    <th className="px-4 py-2 font-medium">tier</th>
                    <th className="px-4 py-2 font-medium text-right">total</th>
                    <th className="px-4 py-2 font-medium text-right">rejected</th>
                    <th className="px-4 py-2 font-medium text-right">cancelled</th>
                    <th className="px-4 py-2 font-medium text-right">postponed</th>
                    <th className="px-4 py-2 font-medium text-right">flagged</th>
                    <th className="px-4 py-2 font-medium text-right">drift</th>
                    <th className="px-4 py-2 font-medium text-right">imageless</th>
                    <th className="px-4 py-2 font-medium text-right">avg complete</th>
                    <th className="px-4 py-2 font-medium text-right">concern</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.promoterId} className="border-b border-border hover:bg-muted">
                      <td className="px-4 py-2 font-mono text-foreground">
                        <Link
                          href={`/promoters/${r.promoterSlug}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-royal hover:underline font-medium"
                        >
                          {r.promoterName}
                        </Link>
                        <div className="text-xs text-muted-foreground font-mono">
                          {r.promoterSlug}
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <TierBadge tier={r.tier} />
                      </td>
                      <Num value={r.total} />
                      <Num value={r.rejected} pct={pct(r.rejected, r.total)} />
                      <Num value={r.cancelled} pct={pct(r.cancelled, r.total)} />
                      <Num value={r.postponed} pct={pct(r.postponed, r.total)} />
                      <Num value={r.gateFlagged} pct={pct(r.gateFlagged, r.total)} />
                      <Num value={r.unresolvedDrift} pct={pct(r.unresolvedDrift, r.total)} />
                      <Num value={r.imageless} pct={pct(r.imageless, r.total)} muted />
                      <td className="px-4 py-2 text-right tabular-nums text-foreground">
                        {r.avgCompleteness}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <ConcernBadge pct={r.concernPct} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Concern % = (rejected + cancelled + postponed + gate-flagged + unresolved-drift) / total.
        Tier thresholds: T1 &lt; 10%, T2 10–25%, T3 ≥ 25%. Promoters with fewer than{" "}
        {MIN_EVENTS_FOR_TIER} events default to T2 (insufficient signal). Imageless rate shown
        separately — it&apos;s a coverage gap, not a quality flag.
      </p>
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
      className={`px-4 py-2 text-right tabular-nums ${muted ? "text-muted-foreground" : "text-foreground"}`}
    >
      {value.toLocaleString()}
      {pct != null && pct > 0 && (
        <span className="ml-1 text-xs text-muted-foreground">({pct}%)</span>
      )}
    </td>
  );
}

function TierBadge({ tier }: { tier: Tier }) {
  const cls =
    tier === "T1"
      ? "bg-green-50 text-green-800 border-green-300"
      : tier === "T2"
        ? "bg-amber-50 text-amber-800 border-amber-300"
        : "bg-red-50 text-red-800 border-red-300";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium border ${cls}`}>
      {tier}
    </span>
  );
}

function ConcernBadge({ pct }: { pct: number }) {
  // Same color thresholds as source-quality for consistency.
  const cls =
    pct >= 25
      ? "bg-red-50 text-red-800 border-red-300"
      : pct >= 10
        ? "bg-amber-50 text-amber-800 border-amber-300"
        : pct > 0
          ? "bg-info-soft text-navy-dark border-info-soft"
          : "bg-green-50 text-green-800 border-green-300";
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-medium border tabular-nums ${cls}`}
    >
      {pct}%
    </span>
  );
}

function TierStat({ label, value, tier }: { label: string; value: number; tier?: Tier }) {
  const cls = !tier
    ? "text-foreground"
    : tier === "T1"
      ? "text-green-700"
      : tier === "T2"
        ? "text-amber-700"
        : "text-red-700";
  return (
    <div>
      <p className={`text-2xl font-bold tabular-nums ${cls}`}>{value.toLocaleString()}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
