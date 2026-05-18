/**
 * §10.2 time-to-index reconciler sweep.
 *
 * For every time_to_index_log row with first_crawl_at IS NULL, look for a
 * matching gsc_inspection_state row where:
 *   - state.url = log.url
 *   - state.lastVerdict = 'PASS' (URL is indexed per Google)
 *   - state.lastInspectedAt > log.indexnow_submitted_at
 *
 * If found, set first_crawl_at = state.lastInspectedAt and lag_seconds =
 * difference in seconds. We don't have direct visibility into Google's
 * actual crawl moment — `lastInspectedAt` is when WE polled GSC URL
 * Inspection — so the lag is an upper bound: "indexed by the time we next
 * looked, no later than this many seconds after submission."
 *
 * Auth: admin session OR X-Internal-Key. Manual sweep, mirrors the other
 * sweep-* endpoints; no cron triggers configured (per project memory).
 */
import { NextResponse } from "next/server";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { timeToIndexLog, gscInspectionState } from "@/lib/db/schema";

export const runtime = "edge";

export async function POST(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  const db = getCloudflareDb();
  const now = new Date();

  try {
    // Single JOIN — replaces the previous N+1 (one SELECT per unresolved
    // row against gsc_inspection_state) that hit Cloudflare's ~100s edge
    // timeout once the unresolved set exceeded a few thousand rows. The
    // 06:02 UTC 2026-05-18 524 fired on 4,453 unresolved × ~5ms/query =
    // ~22s minimum, plus per-row overhead pushing into the timeout band.
    // After this: one query returns only rows that need updating.
    const matches = await db
      .select({
        id: timeToIndexLog.id,
        indexnowSubmittedAt: timeToIndexLog.indexnowSubmittedAt,
        lastInspectedAt: gscInspectionState.lastInspectedAt,
      })
      .from(timeToIndexLog)
      .innerJoin(gscInspectionState, eq(gscInspectionState.url, timeToIndexLog.url))
      .where(
        and(
          isNull(timeToIndexLog.firstCrawlAt),
          eq(gscInspectionState.lastVerdict, "PASS"),
          gt(gscInspectionState.lastInspectedAt, timeToIndexLog.indexnowSubmittedAt)
        )
      );

    // Separate count of unresolved rows for the response's `scanned` field.
    // Cheap (indexed isNull check); preserves the observability metric the
    // cron handler logs after each run.
    const [{ scanned }] = await db
      .select({ scanned: sql<number>`COUNT(*)` })
      .from(timeToIndexLog)
      .where(isNull(timeToIndexLog.firstCrawlAt));

    if (matches.length === 0) {
      return NextResponse.json({ success: true, reconciled: 0, scanned });
    }

    let reconciled = 0;
    for (const m of matches) {
      const lagSeconds = Math.floor(
        (m.lastInspectedAt.getTime() - m.indexnowSubmittedAt.getTime()) / 1000
      );
      await db
        .update(timeToIndexLog)
        .set({
          firstCrawlAt: m.lastInspectedAt,
          lagSeconds,
          computedAt: now,
        })
        .where(eq(timeToIndexLog.id, m.id));
      reconciled++;
    }

    // Median + count for quick observability.
    const [stats] = await db
      .select({
        n: sql<number>`COUNT(*)`,
        // SQLite has no MEDIAN; approximate via avg and percentile separately.
        avg: sql<number>`AVG(${timeToIndexLog.lagSeconds})`,
      })
      .from(timeToIndexLog)
      .where(sql`${timeToIndexLog.lagSeconds} IS NOT NULL`);

    return NextResponse.json({
      success: true,
      scanned,
      reconciled,
      total_resolved: stats?.n ?? 0,
      avg_lag_seconds: stats?.avg ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "internal_error", message }, { status: 500 });
  }
}
