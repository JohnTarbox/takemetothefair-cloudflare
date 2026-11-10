/**
 * Per-promoter quality rows (analyst J5, 2026-05-29). Moved out of the page in
 * OPE-1595 so the table can be paged: tiers are computed in JS from two
 * GROUP BYs, so filtering and paging happen on the computed rows.
 */
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { events, eventDateDriftFindings, promoters } from "@/lib/db/schema";
import type { Database } from "@/lib/db";
import { isCsvRequest, parseListParams, toCsv, type CsvColumn, type ListParams } from "./params";
import { csvResponse } from "./respond";

// Promoters with fewer than this many events default to T2 (watch): not enough
// signal to either trust (T1) or flag (T3).
export const MIN_EVENTS_FOR_TIER = 3;

export type Tier = "T1" | "T2" | "T3";

export interface PromoterQualityRow {
  id: string;
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
  if (total < MIN_EVENTS_FOR_TIER) return "T2";
  if (concernPct >= 25) return "T3";
  if (concernPct >= 10) return "T2";
  return "T1";
}

const tierRank = (t: Tier) => (t === "T3" ? 0 : t === "T2" ? 1 : 2);

/** T3 first (the action target), then highest concern, then highest volume. */
function byPriority(a: PromoterQualityRow, b: PromoterQualityRow): number {
  if (a.tier !== b.tier) return tierRank(a.tier) - tierRank(b.tier);
  if (a.concernPct !== b.concernPct) return b.concernPct - a.concernPct;
  return b.total - a.total;
}

export async function loadPromoterQuality(db: Database): Promise<PromoterQualityRow[]> {
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
    if (r.promoterId) driftByPromoter.set(r.promoterId, Number(r.unresolvedDrift ?? 0));
  }

  return baseRows
    .filter((r) => r.promoterId != null)
    .map((r) => {
      const id = r.promoterId as string;
      const total = Number(r.total ?? 0);
      const rejected = Number(r.rejected ?? 0);
      const cancelled = Number(r.cancelled ?? 0);
      const postponed = Number(r.postponed ?? 0);
      const gateFlagged = Number(r.gateFlagged ?? 0);
      const unresolvedDrift = driftByPromoter.get(id) ?? 0;
      const concerns = rejected + cancelled + postponed + gateFlagged + unresolvedDrift;
      const concernPct = total > 0 ? Math.round((concerns / total) * 1000) / 10 : 0;
      return {
        id,
        promoterName: r.promoterName ?? "(unnamed promoter)",
        promoterSlug: r.promoterSlug as unknown as string,
        total,
        rejected,
        cancelled,
        postponed,
        gateFlagged,
        imageless: Number(r.imageless ?? 0),
        unresolvedDrift,
        avgCompleteness: Math.round(Number(r.avgCompleteness ?? 0)),
        concernPct,
        tier: classifyTier(concernPct, total),
      };
    });
}

const SORTERS: Record<string, (r: PromoterQualityRow) => string | number> = {
  promoter: (r) => r.promoterName.toLowerCase(),
  tier: (r) => tierRank(r.tier),
  total: (r) => r.total,
  rejected: (r) => r.rejected,
  cancelled: (r) => r.cancelled,
  postponed: (r) => r.postponed,
  gateFlagged: (r) => r.gateFlagged,
  unresolvedDrift: (r) => r.unresolvedDrift,
  imageless: (r) => r.imageless,
  avgCompleteness: (r) => r.avgCompleteness,
  concernPct: (r) => r.concernPct,
};

export function selectPromoterQualityRows(
  rows: PromoterQualityRow[],
  params: Pick<ListParams, "q" | "sort" | "dir">,
  tier: string | null
): PromoterQualityRow[] {
  const q = params.q.toLowerCase();
  const matched = rows.filter(
    (r) =>
      (!q || r.promoterName.toLowerCase().includes(q) || r.promoterSlug.includes(q)) &&
      (!tier || r.tier === tier)
  );
  const sorter = params.sort ? SORTERS[params.sort] : undefined;
  if (!sorter) return [...matched].sort(byPriority);
  const mult = params.dir === "desc" ? -1 : 1;
  return [...matched].sort((a, b) => {
    const va = sorter(a);
    const vb = sorter(b);
    const cmp = va < vb ? -1 : va > vb ? 1 : a.id.localeCompare(b.id);
    return cmp * mult;
  });
}

const CSV: CsvColumn<PromoterQualityRow>[] = [
  { header: "promoter", value: (r) => r.promoterName },
  { header: "slug", value: (r) => r.promoterSlug },
  { header: "tier", value: (r) => r.tier },
  { header: "total", value: (r) => r.total },
  { header: "rejected", value: (r) => r.rejected },
  { header: "cancelled", value: (r) => r.cancelled },
  { header: "postponed", value: (r) => r.postponed },
  { header: "gate_flagged", value: (r) => r.gateFlagged },
  { header: "unresolved_drift", value: (r) => r.unresolvedDrift },
  { header: "imageless", value: (r) => r.imageless },
  { header: "avg_completeness", value: (r) => r.avgCompleteness },
  { header: "concern_pct", value: (r) => r.concernPct },
];

export async function respondWithPromoterQuality(
  db: Database,
  searchParams: URLSearchParams
): Promise<NextResponse> {
  const params = parseListParams(searchParams);
  const all = await loadPromoterQuality(db);
  const selected = selectPromoterQualityRows(all, params, searchParams.get("tier"));
  if (isCsvRequest(searchParams)) return csvResponse("promoter-quality", toCsv(CSV, selected));
  const start = (params.page - 1) * params.pageSize;
  return NextResponse.json({
    rows: selected.slice(start, start + params.pageSize),
    total: selected.length,
    page: params.page,
    pageSize: params.pageSize,
    stats: {
      T1: all.filter((r) => r.tier === "T1").length,
      T2: all.filter((r) => r.tier === "T2").length,
      T3: all.filter((r) => r.tier === "T3").length,
      tracked: all.length,
    },
  });
}
