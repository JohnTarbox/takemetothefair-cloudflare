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
import { gscSearchMetrics, ga4DailyMetrics, bingDailyMetrics } from "@/lib/db/schema";
import { getSearchMetricsByDateQueryPage, type ScEnv } from "@/lib/search-console";
import { getDailySiteTotals, type Ga4Env } from "@/lib/ga4";
import { getTrafficStats, type BingEnv } from "@/lib/bing-webmaster";
import { logError } from "@/lib/logger";

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** D1 batch in chunks — one batch over thousands of statements is unwise. */
async function runBatched(
  db: ReturnType<typeof getCloudflareDb>,
  statements: unknown[],
  chunkSize = 50
) {
  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    await db.batch(chunk as unknown as Parameters<typeof db.batch>[0]);
  }
}

export async function POST(request: Request) {
  const fail = await requireAdminAuth(request);
  if (fail) return fail;

  const body = (await request.json().catch(() => ({}))) as {
    start_date?: string;
    end_date?: string;
    skip_ga4?: boolean;
    skip_bing?: boolean;
  };
  // Default incremental window: trailing 3-day GSC lag + re-upsert last few days.
  const startDate = body.start_date ?? isoDaysAgo(7);
  const endDate = body.end_date ?? isoDaysAgo(3);

  const db = getCloudflareDb();
  const env = getCloudflareEnv() as unknown as ScEnv & Ga4Env & BingEnv;
  const siteUrl = env.SC_SITE_URL?.trim() || "https://meetmeatthefair.com/";
  const now = new Date();

  let gscRows = 0;
  let gscError: string | null = null;
  try {
    const rows = await getSearchMetricsByDateQueryPage(env, { startDate, endDate });
    const stmts = rows
      .filter((r) => r.date && r.query && r.page)
      .map((r) =>
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
    await runBatched(db, stmts);
    gscRows = stmts.length;
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
  if (!body.skip_ga4) {
    try {
      const totals = await getDailySiteTotals(env, { startDate, endDate });
      const stmts = totals
        .filter((t) => t.date)
        .map((t) =>
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
      await runBatched(db, stmts);
      ga4Rows = stmts.length;
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
  if (!body.skip_bing) {
    try {
      const series = await getTrafficStats(env, { skipCache: true });
      const stmts = series
        .filter((r) => r.date)
        .map((r) =>
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
      await runBatched(db, stmts);
      bingRows = stmts.length;
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
    ok: gscError === null && ga4Error === null && bingError === null,
    window: { startDate, endDate },
    gsc: { upserted: gscRows, error: gscError },
    ga4: { upserted: ga4Rows, error: ga4Error },
    bing: { upserted: bingRows, error: bingError },
  });
}
