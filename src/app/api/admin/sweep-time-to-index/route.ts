export const dynamic = "force-dynamic";
/**
 * §10.2 / REL5 time-to-index reconciler sweep.
 *
 * For every `time_to_index_log` row with `first_crawl_at IS NULL`, look up
 * Bing's most-recent crawl via the Bing Webmaster API (`getUrlInfo` →
 * `lastCrawled`) and, when that crawl happened AFTER our IndexNow submission,
 * record it as `first_crawl_at` with `lag_seconds = lastCrawled - submittedAt`.
 *
 * Why Bing (not GSC): IndexNow pings Bing, so the relevant crawl is Bing's. The
 * prior version joined `gsc_inspection_state` (Google PASS verdicts), which
 * almost never matched these thin/recurring URLs — leaving all 5,924 rows NULL
 * even though Bing had crawled them. See src/lib/time-to-index-reconcile.ts.
 *
 * No local Bing table exists, so this is live API calls. Capped per run
 * (DEFAULT_LIMIT, override via `?limit=`, clamped to MAX_LIMIT) to fit the
 * Cloudflare ~100s edge budget + Bing quota; the daily 06:00 cron drains the
 * backlog over successive runs. Stops early on a 429.
 *
 * Auth: admin session OR X-Internal-Key. Invoked by the MCP daily cron
 * (`runScheduledTimeToIndexSweep`).
 */
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { getUrlInfo, BingConfigError, type BingEnv } from "@/lib/bing-webmaster";
import { timeToIndexLog } from "@/lib/db/schema";
import { reconcileTimeToIndexFromCrawl } from "@/lib/time-to-index-reconcile";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 400;

export async function POST(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  const db = getCloudflareDb();
  const env = getCloudflareEnv() as unknown as BingEnv;

  // Missing key isn't a hard failure — return 200 so the cron logs it without
  // tripping a deploy/cron alarm. (recordScFailure-style graceful degrade.)
  if (!env.BING_WEBMASTER_API_KEY) {
    return NextResponse.json({
      success: true,
      skipped: "bing_not_configured",
      reconciled: 0,
    });
  }

  const limitParam = Number(new URL(request.url).searchParams.get("limit"));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(Math.floor(limitParam), MAX_LIMIT)
      : DEFAULT_LIMIT;

  try {
    const result = await reconcileTimeToIndexFromCrawl(db, (url) => getUrlInfo(env, url), {
      limit,
    });

    // Cohort-wide lag stats for observability (the cron formatter logs avg_lag).
    const [stats] = await db
      .select({
        n: sql<number>`COUNT(*)`,
        avg: sql<number>`AVG(${timeToIndexLog.lagSeconds})`,
      })
      .from(timeToIndexLog)
      .where(sql`${timeToIndexLog.lagSeconds} IS NOT NULL`);

    return NextResponse.json({
      success: true,
      ...result,
      total_resolved: stats?.n ?? 0,
      avg_lag_seconds: stats?.avg ?? null,
    });
  } catch (error) {
    if (error instanceof BingConfigError) {
      return NextResponse.json({ success: true, skipped: "bing_not_configured", reconciled: 0 });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "internal_error", message }, { status: 500 });
  }
}
