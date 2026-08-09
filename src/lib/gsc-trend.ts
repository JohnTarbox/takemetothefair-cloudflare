/**
 * A12 read surface — query the persisted GSC trend store (`gsc_search_metrics`)
 * for clicks/impressions/CTR/avg-position over time, optionally scoped to a
 * single query and/or page. This reads D1, NOT the live Search Analytics API,
 * so it can answer historical questions (WoW movement, "1.5K clicks/28d",
 * attribute a lift to a ship) that the live tools can't — GSC retains only
 * ~16 months and the live feed is never stored.
 *
 * Pure over its injected `db` so it unit-tests against in-memory SQLite the
 * same way `gsc-sweep`'s pickUrls does (see __tests__/gsc-trend.test.ts).
 */
import { and, eq, gte, lte, like, or, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import { gscDailyTotals, gscSearchMetrics } from "./db/schema";

type Db = DrizzleD1Database<typeof schema>;

export interface GscTrendParams {
  /** Exact GSC query to scope to (e.g. "cummington fair"). */
  query?: string;
  /** Page to scope to — a full URL (exact match) or a path like "/events/x"
   *  (matched as a suffix of the stored full URL). */
  page?: string;
  /** Inclusive YYYY-MM-DD window bounds (lexicographic compare on the text date). */
  startDate?: string;
  endDate?: string;
  /** Optional property scope; omitted = all rows (today: one property). */
  siteUrl?: string;
}

export interface GscTrendPoint {
  date: string;
  clicks: number;
  impressions: number;
  /** clicks / impressions for the day (0 when no impressions). */
  ctr: number;
  /** impression-weighted average position for the day — the correct way to
   *  roll per-(query,page) positions up to a daily figure. */
  position: number;
}

export interface GscTrendResult {
  /**
   * Which store answered (OPE-345). Surfaced so a consumer — or a reviewer
   * reading a number in a report — can tell a property total from a
   * query/page-scoped figure without re-deriving which branch ran.
   */
  source: "gsc_daily_totals" | "gsc_search_metrics";
  series: GscTrendPoint[];
  totals: { clicks: number; impressions: number; ctr: number; position: number; days: number };
  filters: {
    query: string | null;
    page: string | null;
    startDate: string | null;
    endDate: string | null;
  };
}

/** Property-level trend, read from the summable daily-totals table. */
async function propertyTrend(db: Db, params: GscTrendParams): Promise<GscTrendResult> {
  const conds: SQL[] = [];
  if (params.startDate) conds.push(gte(gscDailyTotals.date, params.startDate));
  if (params.endDate) conds.push(lte(gscDailyTotals.date, params.endDate));
  if (params.siteUrl) conds.push(eq(gscDailyTotals.siteUrl, params.siteUrl));

  const rows = await db
    .select({
      date: gscDailyTotals.date,
      clicks: gscDailyTotals.clicks,
      impressions: gscDailyTotals.impressions,
      position: gscDailyTotals.position,
    })
    .from(gscDailyTotals)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(gscDailyTotals.date);

  const series: GscTrendPoint[] = rows.map((r) => {
    const clicks = Number(r.clicks ?? 0);
    const impressions = Number(r.impressions ?? 0);
    return {
      date: r.date,
      clicks,
      impressions,
      ctr: impressions > 0 ? clicks / impressions : 0,
      position: Number(r.position ?? 0),
    };
  });

  const tClicks = series.reduce((s, p) => s + p.clicks, 0);
  const tImpr = series.reduce((s, p) => s + p.impressions, 0);
  // Each row is already a daily property average, so the roll-up weights by
  // impressions the same way the dimensioned path does.
  const tWPos = series.reduce((s, p) => s + p.position * p.impressions, 0);

  return {
    series,
    totals: {
      clicks: tClicks,
      impressions: tImpr,
      ctr: tImpr > 0 ? tClicks / tImpr : 0,
      position: tImpr > 0 ? tWPos / tImpr : 0,
      days: series.length,
    },
    filters: {
      query: null,
      page: null,
      startDate: params.startDate ?? null,
      endDate: params.endDate ?? null,
    },
    source: "gsc_daily_totals",
  };
}

export async function getGscTrend(db: Db, params: GscTrendParams = {}): Promise<GscTrendResult> {
  // OPE-345 — WHICH TABLE depends on whether this is a property-level question.
  //
  // With no query/page filter the caller is asking "how did the SITE do", and
  // summing the dimensioned store answers that wrong: GSC omits anonymized and
  // long-tail rows from dimensioned responses, which for July 2026 meant 3,305
  // clicks against Google's own 9,370. Property-level reads therefore come from
  // gsc_daily_totals, which is filled from a date-dimensioned request.
  //
  // WITH a query or page filter, the dimensioned table is the ONLY source that
  // can answer at all, and summing it is correct — the omitted rows are other
  // queries, not part of the one being asked about.
  const propertyLevel = !params.query && !params.page;
  if (propertyLevel) return await propertyTrend(db, params);

  const conds: SQL[] = [];
  if (params.query) conds.push(eq(gscSearchMetrics.query, params.query));
  if (params.page) {
    // Accept a full URL (exact) OR a path suffix of the stored full URL.
    conds.push(
      or(eq(gscSearchMetrics.page, params.page), like(gscSearchMetrics.page, `%${params.page}`))!
    );
  }
  if (params.startDate) conds.push(gte(gscSearchMetrics.date, params.startDate));
  if (params.endDate) conds.push(lte(gscSearchMetrics.date, params.endDate));
  if (params.siteUrl) conds.push(eq(gscSearchMetrics.siteUrl, params.siteUrl));

  const rows = await db
    .select({
      date: gscSearchMetrics.date,
      clicks: sql<number>`sum(${gscSearchMetrics.clicks})`,
      impressions: sql<number>`sum(${gscSearchMetrics.impressions})`,
      // Weighted-position numerator: Σ(position × impressions). Divided by
      // total impressions below to get the impression-weighted average.
      weightedPos: sql<number>`sum(${gscSearchMetrics.position} * ${gscSearchMetrics.impressions})`,
    })
    .from(gscSearchMetrics)
    .where(conds.length ? and(...conds) : undefined)
    .groupBy(gscSearchMetrics.date)
    .orderBy(gscSearchMetrics.date);

  const series: GscTrendPoint[] = rows.map((r) => {
    const clicks = Number(r.clicks ?? 0);
    const impressions = Number(r.impressions ?? 0);
    const weightedPos = Number(r.weightedPos ?? 0);
    return {
      date: r.date,
      clicks,
      impressions,
      ctr: impressions > 0 ? clicks / impressions : 0,
      position: impressions > 0 ? weightedPos / impressions : 0,
    };
  });

  const tClicks = series.reduce((s, p) => s + p.clicks, 0);
  const tImpr = series.reduce((s, p) => s + p.impressions, 0);
  const tWPos = rows.reduce((s, r) => s + Number(r.weightedPos ?? 0), 0);

  return {
    // Query/page-scoped: the dimensioned store is the only source that can
    // answer, and summing it is correct for a single key.
    source: "gsc_search_metrics",
    series,
    totals: {
      clicks: tClicks,
      impressions: tImpr,
      ctr: tImpr > 0 ? tClicks / tImpr : 0,
      position: tImpr > 0 ? tWPos / tImpr : 0,
      days: series.length,
    },
    filters: {
      query: params.query ?? null,
      page: params.page ?? null,
      startDate: params.startDate ?? null,
      endDate: params.endDate ?? null,
    },
  };
}
