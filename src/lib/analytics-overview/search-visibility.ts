/**
 * Search-visibility domain loaders: GSC headline + BWT companion, the GSC
 * daily sparkline, site CTR, brand-vs-non-brand split, and the 90-day KPI
 * strip (which reuses the conversions/publishing day-series loaders).
 */

import { and, count, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { analyticsEvents, gscDailyTotals, indexnowSubmissions } from "@/lib/db/schema";
import { rate, rateOverSample, type Measurement } from "./render-state";
import { resolveDateRange } from "@/lib/analytics-params";
import { BingApiError, BingConfigError, getQueryStats, type BingEnv } from "@/lib/bing-webmaster";
import {
  ScApiError,
  ScConfigError,
  getDailyClicks,
  getSiteSearchQueries,
  getSitePropertyTotals,
  type ScEnv,
} from "@/lib/search-console";
import {
  CONVERSION_EVENT_NAMES,
  SPARKLINE_DAYS,
  emptyDailySeries,
  fillDailySeries,
  fillDailySeriesTrimTrailing,
  gscWindowRange,
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
  SparklineSeries,
} from "./types";

/**
 * §10.3 brand-keyword list. Anything containing one of these substrings
 * (case-insensitive) counts as a brand query in the brand-vs-non-brand split.
 */
const BRAND_KEYWORDS = ["meet me at the fair", "meetmeatthefair", "mmatf", "take me to the fair"];

export async function loadSearchVisibilitySparkline(env: ScEnv): Promise<SparklineSeries> {
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
      // Zero-filled so the chart draws; TAGGED so the total is not read as 0.
      return Object.assign(emptyDailySeries(SPARKLINE_DAYS), {
        unavailableReason: `GSC unavailable — ${e.message}`,
      });
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
    // OPE-1161 B9 — N inclusive days, shared with Brand share.
    const dateRange = gscWindowRange(days);
    // OPE-312 (audit A3) — read the headline from a TRUE property total.
    //
    // getSiteSearchQueries sums the rows it fetched, so its `totals` are really
    // "totals of the top N". Raising rowLimit to the 500 API max narrowed the
    // gap but could never close it: a long-tail property keeps clicks outside
    // any N, so the headline was systematically low and moved whenever the row
    // limit did. An un-dimensioned Search Analytics query returns the real
    // property aggregate in one row — that is what a tile labelled "total"
    // should show, and it is the same call the 7K-milestone analysis needed.
    const totals = await getSitePropertyTotals(env, { dateRange });
    const current = totals.clicks;

    // Previous window: roll the same number of days back.
    const priorEnd = isoFromDate(
      new Date(Date.parse(`${totals.dateRange.startDate}T00:00:00Z`) - 86400_000)
    );
    const priorStart = isoFromDate(
      new Date(Date.parse(`${totals.dateRange.startDate}T00:00:00Z`) - days * 86400_000)
    );
    const priorTotals = await getSitePropertyTotals(env, {
      dateRange: { startDate: priorStart, endDate: priorEnd },
    });
    const previous = priorTotals.clicks;

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
      // OPE-1347 #5 — the exact dates GSC was asked for, so this tile and the
      // CTR tile (a different, lagged window) can never be read as one window.
      window: (() => {
        const r = resolveDateRange(dateRange, { defaultPreset: "last_30d" });
        return { start: r.startDate, end: r.endDate };
      })(),
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

/** Queries read for the site-wide CTR / brand-share figures (a GSC sample cap). */
const QUERY_SAMPLE_CAP = 500;

/**
 * OPE-1347 #4 — the CTR card's sub-lines read the SAME table and window as its
 * headline badge (kpi-states `readSiteCtr`): un-dimensioned `gsc_daily_totals`,
 * a window ending STABLE_LAG_DAYS ago so GSC's late-finalising days are excluded.
 *
 * They used to come from the top-500-query API sample over an un-lagged window,
 * so the card showed "1.94%" above "1,893 / 108,170" (1.75%) and a "prev" from
 * a third population. Two numbers on one card must be one measurement.
 */
const CTR_STABLE_LAG_DAYS = 2;

export async function loadSiteCtr(db: Db, days: number): Promise<SiteCtrCard> {
  const dayMs = 86400 * 1000;
  const end = new Date(Date.now() - CTR_STABLE_LAG_DAYS * dayMs); // exclusive
  const start = new Date(end.getTime() - days * dayMs);
  const prevStart = new Date(start.getTime() - days * dayMs);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const sum = async (from: Date, to: Date) => {
    const [row] = await db
      .select({
        clicks: sql<number>`COALESCE(SUM(${gscDailyTotals.clicks}), 0)`,
        impressions: sql<number>`COALESCE(SUM(${gscDailyTotals.impressions}), 0)`,
        days: sql<number>`COUNT(*)`,
      })
      .from(gscDailyTotals)
      .where(and(gte(gscDailyTotals.date, iso(from)), lt(gscDailyTotals.date, iso(to))));
    return {
      clicks: Number(row?.clicks ?? 0),
      impressions: Number(row?.impressions ?? 0),
      days: Number(row?.days ?? 0),
    };
  };
  const [curr, prev] = await Promise.all([sum(start, end), sum(prevStart, start)]);
  if (curr.days === 0) {
    return {
      ok: false,
      reason: `no gsc_daily_totals rows for ${iso(start)}–${iso(new Date(end.getTime() - dayMs))}`,
    };
  }
  const ctr = curr.impressions > 0 ? curr.clicks / curr.impressions : 0;
  const prevCtr = prev.impressions > 0 ? prev.clicks / prev.impressions : 0;
  return {
    ok: true,
    clicks: curr.clicks,
    impressions: curr.impressions,
    ctr,
    ctrMeasured: rate(curr.clicks, curr.impressions, "no impressions in window"),
    previousCtr: prevCtr,
    previousMeasured: rate(prev.clicks, prev.impressions, "no prior-window data"),
    trend: trendOf(ctr, prevCtr),
    windowStart: iso(start),
    windowEnd: iso(new Date(end.getTime() - dayMs)), // inclusive, for display
  };
}

/**
 * OPE-1347 rework #4 — brand share over the top-N query sample.
 *
 * Brand queries are real but tiny: 2 clicks / 12 impressions over 2026-10-04→11
 * in `gsc_search_metrics`, against 3,236 clicks overall. They rank below the
 * 500-query cutoff, so a capped sample usually holds NO brand row at all, and
 * the tile read "0 of 108,170 impressions" — which looks like a broken matcher,
 * not a sample floor. When the cap was hit and no brand query made the sample,
 * the share is unknowable from it: say so instead of printing 0%. When the
 * sample was complete (cap not hit), a zero is a real zero.
 */
export function brandShareOverSample(
  brandClicks: number,
  brandImpressions: number,
  totalClicks: number,
  sampleSize: number,
  cap: number,
  populationTotal: number | undefined
): Measurement<number> {
  const capped = sampleSize >= cap && (populationTotal ?? sampleSize) > sampleSize;
  if (capped && brandImpressions === 0 && totalClicks > 0) {
    return {
      state: "truncated",
      value: null,
      reason: `no brand query ranked in the top ${cap} — brand volume is below the sample floor, not 0%`,
      sampled: { of: populationTotal ?? sampleSize, cap },
    };
  }
  return rateOverSample(
    brandClicks,
    totalClicks,
    "no clicks in window",
    sampleSize,
    cap,
    populationTotal
  );
}

export async function loadBrandVsNonBrand(env: ScEnv, days: number): Promise<BrandVsNonBrandCard> {
  // Honor the dashboard window. Without this, the card always read 28d
  // (getSiteSearchQueries default), creating the analyst-flagged
  // discrepancy where SearchVisibility shows 25 clicks @ 7d but
  // brand+non-brand summed to 53 clicks @ 28d on the same page.
  try {
    // OPE-1161 B9 — the same N-inclusive-day range as the Google clicks card.
    const dateRange = gscWindowRange(days);
    const result = await getSiteSearchQueries(env, { rowLimit: QUERY_SAMPLE_CAP, dateRange });
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
      brandShareMeasured: brandShareOverSample(
        brand_clicks,
        brand_impressions,
        total_clicks,
        result.totals.queries,
        QUERY_SAMPLE_CAP,
        result.totals.queriesBeforeLimit
      ),
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
        if (e instanceof ScConfigError || e instanceof ScApiError) {
          return Object.assign(emptyDailySeries(90), {
            unavailableReason: `GSC unavailable — ${e.message}`,
          });
        }
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
