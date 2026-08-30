export const dynamic = "force-dynamic";
/**
 * A12 + K50 — GSC + GA4 + Bing search-performance time-series → D1.
 *
 * The live analytics widgets fetch GSC `searchAnalytics/query`, the GA4 Data
 * API, and Bing's GetRankAndTrafficStats on every request and never persist, so
 * there's no history to chart and Google only retains ~16 months. This endpoint
 * upserts the durable trend tables `gsc_search_metrics` (one row per
 * date×query×page), `ga4_daily_metrics` (one row per day), and
 * `bing_daily_metrics` (K50 — one row per day; Bing exposes daily site totals
 * only, not query×page).
 *
 * Two modes, same handler:
 *   - **Incremental (default):** window = [today-7, today-3]. The trailing 3-day
 *     cushion absorbs GSC's reporting lag; re-upserting the last several days
 *     captures Google's retroactive revisions to recent dates. This is what the
 *     daily MCP-Worker cron calls. (The Bing feed ignores the window — its API
 *     returns the full retained series in one call, so its daily upsert also
 *     backfills.)
 *   - **Backfill:** pass explicit `start_date` / `end_date` (the first-run GSC
 *     16-month backfill is driven range-by-range by scripts/gsc-backfill.ts so
 *     each request stays within Worker limits).
 *
 * GSC, GA4, and Bing are persisted in independent try/catch blocks — one feed's
 * outage must not drop another's write; failures are logged, never thrown, so a
 * partial sync still records what it could (observability discipline, A8/MIG7).
 *
 * Dual auth via requireAdminAuth: admin session OR X-Internal-Key (the cron).
 */
import { NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import {
  gscDailyTotals,
  gscSearchMetrics,
  ga4DailyMetrics,
  bingDailyMetrics,
} from "@/lib/db/schema";
import { getDailyTotals, getSearchMetricsByDateQueryPage, type ScEnv } from "@/lib/search-console";
import { getDailySiteTotals, type Ga4Env } from "@/lib/ga4";
import { getTrafficStats, type BingEnv } from "@/lib/bing-webmaster";
import { logError } from "@/lib/logger";
import { upsertInChunks } from "@/lib/db/upsert-in-chunks";

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * OPE-641 — `runBatched` was deleted, not adjusted.
 *
 * It chunked the EXECUTION of an array the caller had already built with
 * `.map()`, so peak memory was spent before its first `batch()`. One ordinary
 * daily run built 15,000–25,000 Drizzle statement objects at once and crossed
 * the Worker's 128 MB isolate ceiling. `upsertInChunks` builds and executes one
 * chunk at a time; see that file for the measurements.
 */

export async function POST(request: Request) {
  const fail = await requireAdminAuth(request);
  if (fail) return fail;

  const body = (await request.json().catch(() => ({}))) as {
    start_date?: string;
    end_date?: string;
    skip_ga4?: boolean;
    skip_bing?: boolean;
    /**
     * OPE-345 backfill: write ONLY gsc_daily_totals and skip every other feed.
     *
     * Needed because a 16-month backfill through the normal path would also
     * re-pull the (query, page) store — roughly 950k rows at ~59k/month — which
     * is both pointless (that data is already there) and a good way to hit D1
     * limits. The totals request returns one row per day, so the same window is
     * a single cheap call.
     */
    totals_only?: boolean;
  };
  // Default incremental window: trailing 3-day GSC lag + re-upsert last few days.
  const startDate = body.start_date ?? isoDaysAgo(7);
  const endDate = body.end_date ?? isoDaysAgo(3);

  const db = getCloudflareDb();
  const env = getCloudflareEnv() as unknown as ScEnv & Ga4Env & BingEnv;
  const siteUrl = env.SC_SITE_URL?.trim() || "https://meetmeatthefair.com/";
  const now = new Date();

  // OPE-345 — property-level daily totals, written from a DATE-dimensioned
  // request. This is the only summable source: the (query, page) store below
  // undercounts property totals by ~65% because GSC omits anonymized and
  // long-tail rows from dimensioned responses. Both are synced here so they can
  // never drift out of step with each other.
  let totalsRows = 0;
  let totalsError: string | null = null;
  try {
    const totals = await getDailyTotals(env, { startDate, endDate });
    totalsRows = await upsertInChunks(db, totals, (t) =>
      db
        .insert(gscDailyTotals)
        .values({
          siteUrl,
          date: t.date,
          clicks: t.clicks,
          impressions: t.impressions,
          ctr: t.ctr,
          position: t.position,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [gscDailyTotals.siteUrl, gscDailyTotals.date],
          set: {
            clicks: t.clicks,
            impressions: t.impressions,
            ctr: t.ctr,
            position: t.position,
            updatedAt: now,
          },
        })
    );
  } catch (err) {
    // Isolated from the dimensioned sync below: one feed failing must not take
    // out the other, or a bad day loses both the totals AND the detail.
    totalsError = err instanceof Error ? err.message : String(err);
  }

  // `skipDetail` short-circuits the three heavy feeds rather than throwing past
  // them — a thrown skip would land in each catch and be reported as an error,
  // making a deliberate backfill look like three failures.
  const skipDetail = body.totals_only === true;

  let gscRows = 0;
  let gscError: string | null = null;
  if (!skipDetail)
    try {
      const rows = (await getSearchMetricsByDateQueryPage(env, { startDate, endDate })).filter(
        (r) => r.date && r.query && r.page
      );
      // The heavy one: 3,000-5,000 rows/day over a 5-day window.
      gscRows = await upsertInChunks(db, rows, (r) =>
        db
          .insert(gscSearchMetrics)
          .values({
            date: r.date,
            query: r.query,
            page: r.page,
            clicks: r.clicks,
            impressions: r.impressions,
            ctr: r.ctr,
            position: r.position,
            siteUrl,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              gscSearchMetrics.siteUrl,
              gscSearchMetrics.date,
              gscSearchMetrics.query,
              gscSearchMetrics.page,
            ],
            set: {
              clicks: r.clicks,
              impressions: r.impressions,
              ctr: r.ctr,
              position: r.position,
              updatedAt: now,
            },
          })
      );
    } catch (e) {
      gscError = e instanceof Error ? e.message : String(e);
      await logError(db, {
        source: "app/api/admin/analytics/gsc-metrics/sync:gsc",
        message: "GSC search-metrics sync failed",
        error: e,
        context: { startDate, endDate },
      });
    }

  let ga4Rows = 0;
  let ga4Error: string | null = null;
  if (!body.skip_ga4 && !skipDetail) {
    try {
      const totals = (await getDailySiteTotals(env, { startDate, endDate })).filter((t) => t.date);
      ga4Rows = await upsertInChunks(db, totals, (t) =>
        db
          .insert(ga4DailyMetrics)
          .values({
            date: t.date,
            activeUsers: t.activeUsers,
            sessions: t.sessions,
            keyEvents: t.keyEvents,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: ga4DailyMetrics.date,
            set: {
              activeUsers: t.activeUsers,
              sessions: t.sessions,
              keyEvents: t.keyEvents,
              updatedAt: now,
            },
          })
      );
    } catch (e) {
      ga4Error = e instanceof Error ? e.message : String(e);
      await logError(db, {
        source: "app/api/admin/analytics/gsc-metrics/sync:ga4",
        message: "GA4 daily-metrics sync failed",
        error: e,
        context: { startDate, endDate },
      });
    }
  }

  // K50 — Bing daily traffic totals. GetRankAndTrafficStats returns the full
  // retained series in one call (no date-range param), so this upserts every
  // returned day regardless of the GSC window — the daily sync doubles as the
  // backfill. skipCache so the persisted history is ground truth, not a 15-min
  // cached snapshot.
  let bingRows = 0;
  let bingError: string | null = null;
  if (!body.skip_bing && !skipDetail) {
    try {
      const series = (await getTrafficStats(env, { skipCache: true })).filter((r) => r.date);
      bingRows = await upsertInChunks(db, series, (r) =>
        db
          .insert(bingDailyMetrics)
          .values({
            date: r.date,
            impressions: r.impressions,
            clicks: r.clicks,
            siteUrl,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: bingDailyMetrics.date,
            set: { impressions: r.impressions, clicks: r.clicks, updatedAt: now },
          })
      );
    } catch (e) {
      bingError = e instanceof Error ? e.message : String(e);
      await logError(db, {
        source: "app/api/admin/analytics/gsc-metrics/sync:bing",
        message: "Bing daily-metrics sync failed",
        error: e,
        context: { startDate, endDate },
      });
    }
  }

  // 200 even on a partial failure: the per-feed error strings tell the cron
  // logger / operator what dropped, while the feed that succeeded is recorded.
  return NextResponse.json({
    ok: gscError === null && ga4Error === null && bingError === null && totalsError === null,
    window: { startDate, endDate },
    // OPE-345 — the summable feed, reported separately from the dimensioned one
    // so a silent failure here is visible rather than hidden behind gsc.ok.
    gscDailyTotals: { upserted: totalsRows, error: totalsError },
    gsc: { upserted: gscRows, error: gscError },
    ga4: { upserted: ga4Rows, error: ga4Error },
    bing: { upserted: bingRows, error: bingError },
  });
}
