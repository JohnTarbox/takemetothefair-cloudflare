/**
 * Search-visibility domain loaders: GSC headline + BWT companion, the GSC
 * daily sparkline, site CTR, brand-vs-non-brand split, and the 90-day KPI
 * strip (which reuses the conversions/publishing day-series loaders).
 */

import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { analyticsEvents, indexnowSubmissions } from "@/lib/db/schema";
import { BingApiError, BingConfigError, getQueryStats, type BingEnv } from "@/lib/bing-webmaster";
import {
  ScApiError,
  ScConfigError,
  getDailyClicks,
  getSiteSearchQueries,
  type ScEnv,
} from "@/lib/search-console";
import {
  CONVERSION_EVENT_NAMES,
  SPARKLINE_DAYS,
  emptyDailySeries,
  fillDailySeries,
  fillDailySeriesTrimTrailing,
  isoDaysAgo,
  isoFromDate,
  trendOf,
  type Db,
} from "./shared";
import type {
  BrandVsNonBrandCard,
  KpiSparklineStrip,
  SearchVisibilityCard,
  SiteCtrCard,
  SparklinePoint,
} from "./types";

/**
 * §10.3 brand-keyword list. Anything containing one of these substrings
 * (case-insensitive) counts as a brand query in the brand-vs-non-brand split.
 */
const BRAND_KEYWORDS = ["meet me at the fair", "meetmeatthefair", "mmatf", "take me to the fair"];

export async function loadSearchVisibilitySparkline(env: ScEnv): Promise<SparklinePoint[]> {
  // GSC daily aggregation. Returns 0-filled empty series on config/api errors so
  // the UI doesn't break — error visibility lives in the Google tab.
  try {
    const rows = await getDailyClicks(env, { days: SPARKLINE_DAYS });
    const byDate = new Map<string, number>();
    for (const r of rows) byDate.set(r.date, r.clicks);
    // OPE-95: trim the unreported trailing days (GSC lags ~2-3d) so the chart
    // ends at the last day with data instead of a false cliff to zero.
    return fillDailySeriesTrimTrailing(byDate, SPARKLINE_DAYS);
  } catch (e) {
    if (e instanceof ScConfigError || e instanceof ScApiError) {
      return emptyDailySeries(SPARKLINE_DAYS);
    }
    throw e;
  }
}

// ── Row 1 — KPI cards ──────────────────────────────────────────────

export async function loadSearchVisibility(
  env: ScEnv & BingEnv,
  days: number
): Promise<SearchVisibilityCard> {
  // GSC supports 1d/7d/28d/30d/90d ranges; map non-preset windows to a custom range.
  // The headline is GSC-only (Google's API gives day-bucketed totals); BWT clicks
  // are added as a footer hint via getQueryStats() — Bing's API doesn't expose a
  // windowable totals endpoint, so combining 7d-GSC + lifetime-BWT into a single
  // number would mislead. Surfacing both honestly fixes the analyst's complaint
  // that "-100%" reads as catastrophic when Bing is delivering ~28 clicks fine.
  try {
    const presetByDays: Record<number, "last_7d" | "last_28d" | "last_90d"> = {
      7: "last_7d",
      28: "last_28d",
      30: "last_28d",
      90: "last_90d",
    };
    const preset = presetByDays[days];
    const dateRange = preset
      ? { preset }
      : (() => {
          // Custom range: ending 3 days ago (GSC has reporting lag).
          const end = isoDaysAgo(3);
          const start = isoDaysAgo(3 + days);
          return { startDate: start, endDate: end };
        })();
    // rowLimit drives totals: getSiteSearchQueries computes totals.clicks by
    // summing the *returned* rows (after slice). Use 500 (API max) so the
    // headline KPI captures essentially all clicks, not just the top query.
    const result = await getSiteSearchQueries(env, { dateRange, rowLimit: 500 });
    const current = result.totals.clicks;

    // Previous window: roll the same number of days back.
    const priorEnd = isoFromDate(
      new Date(Date.parse(`${result.dateRange.startDate}T00:00:00Z`) - 86400_000)
    );
    const priorStart = isoFromDate(
      new Date(Date.parse(`${result.dateRange.startDate}T00:00:00Z`) - days * 86400_000)
    );
    const priorResult = await getSiteSearchQueries(env, {
      dateRange: { startDate: priorStart, endDate: priorEnd },
      rowLimit: 500,
    });
    const previous = priorResult.totals.clicks;

    // BWT companion: best-effort. A failure here doesn't sink the whole card —
    // the GSC headline is the load-bearing signal.
    let bingTotal: number | null = null;
    try {
      const bingRows = await getQueryStats(env);
      bingTotal = bingRows.reduce((sum, row) => sum + row.clicks, 0);
    } catch (e) {
      if (!(e instanceof BingApiError) && !(e instanceof BingConfigError)) {
        // Unexpected — let it surface in logs but don't break the page.
        console.warn("[search-visibility] BWT companion failed:", e);
      }
    }

    return {
      ok: true,
      current,
      previous,
      trend: trendOf(current, previous),
      windowDays: days,
      bingTotal,
    };
  } catch (error) {
    if (error instanceof ScConfigError) return { ok: false, reason: "GSC not configured" };
    if (error instanceof ScApiError) return { ok: false, reason: `GSC API error: ${error.detail}` };
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "GSC unknown error",
    };
  }
}

// §10.3 loaders ─────────────────────────────────────────────────

export async function loadSiteCtr(env: ScEnv, days: number): Promise<SiteCtrCard> {
  // Prior period of equal length, immediately preceding.
  const today = new Date();
  const startCurr = new Date(today.getTime() - days * 86400 * 1000);
  const startPrev = new Date(today.getTime() - 2 * days * 86400 * 1000);
  const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
  try {
    const [curr, prev] = await Promise.all([
      getSiteSearchQueries(env, {
        rowLimit: 500,
        dateRange: { startDate: fmtDate(startCurr), endDate: fmtDate(today) },
      }),
      getSiteSearchQueries(env, {
        rowLimit: 500,
        dateRange: { startDate: fmtDate(startPrev), endDate: fmtDate(startCurr) },
      }),
    ]);
    const ctr = curr.totals.impressions > 0 ? curr.totals.clicks / curr.totals.impressions : 0;
    const prevCtr = prev.totals.impressions > 0 ? prev.totals.clicks / prev.totals.impressions : 0;
    return {
      ok: true,
      clicks: curr.totals.clicks,
      impressions: curr.totals.impressions,
      ctr,
      previousCtr: prevCtr,
      trend: trendOf(ctr, prevCtr),
    };
  } catch (e) {
    if (e instanceof ScConfigError || e instanceof ScApiError) {
      return { ok: false, reason: e.message };
    }
    throw e;
  }
}

export async function loadBrandVsNonBrand(env: ScEnv, days: number): Promise<BrandVsNonBrandCard> {
  // Honor the dashboard window. Without this, the card always read 28d
  // (getSiteSearchQueries default), creating the analyst-flagged
  // discrepancy where SearchVisibility shows 25 clicks @ 7d but
  // brand+non-brand summed to 53 clicks @ 28d on the same page.
  try {
    const presetByDays: Record<number, "last_7d" | "last_28d" | "last_90d"> = {
      7: "last_7d",
      28: "last_28d",
      30: "last_28d",
      90: "last_90d",
    };
    const preset = presetByDays[days];
    const dateRange = preset
      ? { preset }
      : (() => {
          const today = new Date();
          const start = new Date(today.getTime() - days * 86400 * 1000);
          const fmt = (d: Date) => d.toISOString().slice(0, 10);
          return { startDate: fmt(start), endDate: fmt(today) };
        })();
    const result = await getSiteSearchQueries(env, { rowLimit: 500, dateRange });
    let brand_clicks = 0;
    let brand_impressions = 0;
    let non_brand_clicks = 0;
    let non_brand_impressions = 0;
    for (const row of result.queries) {
      const q = row.query.toLowerCase();
      const isBrand = BRAND_KEYWORDS.some((k) => q.includes(k));
      if (isBrand) {
        brand_clicks += row.clicks;
        brand_impressions += row.impressions;
      } else {
        non_brand_clicks += row.clicks;
        non_brand_impressions += row.impressions;
      }
    }
    const total_clicks = brand_clicks + non_brand_clicks;
    return {
      ok: true,
      brand_clicks,
      brand_impressions,
      non_brand_clicks,
      non_brand_impressions,
      brand_share: total_clicks > 0 ? brand_clicks / total_clicks : 0,
      windowDays: days,
    };
  } catch (e) {
    if (e instanceof ScConfigError || e instanceof ScApiError) {
      return { ok: false, reason: e.message };
    }
    throw e;
  }
}

export async function loadKpiStrip90d(db: Db, env: ScEnv): Promise<KpiSparklineStrip> {
  // 90-day sparklines for the three top KPIs. Reuses the 30-day loaders
  // by passing a deeper sinceDate; GSC daily clicks call uses days=90.
  const since90 = new Date(Date.now() - 90 * 86400 * 1000);
  const [searchVisibility, conversions, publishing] = await Promise.all([
    (async () => {
      try {
        const rows = await getDailyClicks(env, { days: 90 });
        const byDate = new Map<string, number>();
        for (const r of rows) byDate.set(r.date, r.clicks);
        // OPE-95: trim the unreported GSC trailing days (see the 30d loader).
        return fillDailySeriesTrimTrailing(byDate, 90);
      } catch (e) {
        if (e instanceof ScConfigError || e instanceof ScApiError) return emptyDailySeries(90);
        throw e;
      }
    })(),
    loadConversionsSparklineDays(db, since90, 90),
    loadPublishingSparklineDays(db, since90, 90),
  ]);
  return { searchVisibility, conversions, publishing };
}

// 90-day variants of the existing 30-day sparkline loaders. Same SQL shape
// but parameterized on the bucket count so we don't duplicate the gather.
export async function loadConversionsSparklineDays(
  db: Db,
  sinceDate: Date,
  days: number
): Promise<SparklinePoint[]> {
  const rows = await db
    .select({
      date: sql<string>`strftime('%Y-%m-%d', ${analyticsEvents.timestamp}, 'unixepoch')`,
      n: count(),
    })
    .from(analyticsEvents)
    .where(
      and(
        inArray(analyticsEvents.eventName, [...CONVERSION_EVENT_NAMES]),
        gte(analyticsEvents.timestamp, sinceDate)
      )
    )
    .groupBy(sql`strftime('%Y-%m-%d', ${analyticsEvents.timestamp}, 'unixepoch')`);
  const byDate = new Map<string, number>();
  for (const r of rows) byDate.set(r.date, r.n);
  return fillDailySeries(byDate, days);
}

async function loadPublishingSparklineDays(
  db: Db,
  sinceDate: Date,
  days: number
): Promise<SparklinePoint[]> {
  const rows = await db
    .select({
      date: sql<string>`strftime('%Y-%m-%d', ${indexnowSubmissions.timestamp}, 'unixepoch')`,
      n: count(),
    })
    .from(indexnowSubmissions)
    .where(
      and(eq(indexnowSubmissions.status, "success"), gte(indexnowSubmissions.timestamp, sinceDate))
    )
    .groupBy(sql`strftime('%Y-%m-%d', ${indexnowSubmissions.timestamp}, 'unixepoch')`);
  const byDate = new Map<string, number>();
  for (const r of rows) byDate.set(r.date, r.n);
  return fillDailySeries(byDate, days);
}
