/**
 * D — DQ3 safety-net (2026-06-06): daily completeness-score recompute.
 *
 * Context: `vendors.completeness_score` and `events.completeness_score` are
 * cached values, refreshed only when a write path calls
 * `recomputeVendorCompleteness` / `recomputeEventCompleteness` (in this
 * file's sibling `helpers.ts` and the main app's `src/lib/completeness.ts`).
 * App + MCP write paths already do this; the rot happens when ad-hoc bulk
 * enrichment runs against D1 directly (or future backfill scripts that skip
 * the helpers). On 2026-06-06 the operator had to manually re-run recompute
 * on the entire table to clear a 0.55 → 0.98 cache lag for sitemap_quality.
 *
 * This cron is the belt-and-suspenders: every day at 06:00 UTC (alongside
 * the other heavy sweeps), pick up to N rows per table whose `updated_at`
 * is within the lookback window and recompute their score. If the cached
 * value already matches the live rubric, the UPDATE is a no-op write —
 * cheap, safe, idempotent. If it doesn't, the cache is restored.
 *
 * Bounded cost: at most 2 × LIMIT_PER_TABLE recompute roundtrips per day,
 * each reading ~8 columns and writing one. Single-table SELECT with
 * `ORDER BY updated_at DESC LIMIT N` is index-friendly (idx on updated_at).
 *
 * Cosmetic-failsoft per [[feedback_workflow_cosmetic_steps_failsoft]]: the
 * helper catches its own errors and returns a result struct so a single
 * bad row doesn't pull down the sibling daily sweeps. The whole cron is
 * non-load-bearing — missing it just delays detection of cache rot by 24h.
 */
import { desc, sql } from "drizzle-orm";
import { events, vendors } from "./schema.js";
import { recomputeEventCompleteness, recomputeVendorCompleteness } from "./helpers.js";
import type { Db } from "./db.js";

/** Max rows to recompute per table per fire. Keeps the cron cheap and
 *  bounded; a row that gets rotated out of the window today will land
 *  in the next-day window. */
const LIMIT_PER_TABLE = 500;

/** Lookback window in seconds. Rows whose updated_at is within this
 *  many seconds of "now" get recomputed. 24h is the natural choice for
 *  a daily cron — every row touched since the last fire is in scope. */
const LOOKBACK_SECONDS = 24 * 60 * 60;

export interface CompletenessRecomputeResult {
  vendors: { scanned: number; recomputed: number; errored: number };
  events: { scanned: number; recomputed: number; errored: number };
}

/**
 * Recompute completeness on the N most-recently-updated rows in each
 * table. Returns a result struct; never throws.
 */
export async function runScheduledCompletenessRecompute(
  db: Db
): Promise<CompletenessRecomputeResult> {
  const result: CompletenessRecomputeResult = {
    vendors: { scanned: 0, recomputed: 0, errored: 0 },
    events: { scanned: 0, recomputed: 0, errored: 0 },
  };

  const cutoffSeconds = Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS;

  try {
    const recentVendors = await db
      .select({ id: vendors.id })
      .from(vendors)
      // updated_at is stored seconds-epoch (Drizzle mode:"timestamp"). Use a
      // raw sql comparison rather than gte() — gte() expects a Date here and
      // the Drizzle adapter coerces, but the raw form keeps intent obvious.
      .where(sql`${vendors.updatedAt} >= ${cutoffSeconds} AND ${vendors.deletedAt} IS NULL`)
      .orderBy(desc(vendors.updatedAt))
      .limit(LIMIT_PER_TABLE);
    result.vendors.scanned = recentVendors.length;
    for (const row of recentVendors) {
      try {
        const score = await recomputeVendorCompleteness(db, row.id);
        if (score !== null) result.vendors.recomputed += 1;
      } catch {
        result.vendors.errored += 1;
      }
    }
  } catch {
    // SELECT failure (extremely unlikely; index-friendly query). Fall
    // through to the events leg — partial progress beats no progress.
    result.vendors.errored += 1;
  }

  try {
    const recentEvents = await db
      .select({ id: events.id })
      .from(events)
      .where(sql`${events.updatedAt} >= ${cutoffSeconds}`)
      .orderBy(desc(events.updatedAt))
      .limit(LIMIT_PER_TABLE);
    result.events.scanned = recentEvents.length;
    for (const row of recentEvents) {
      try {
        const score = await recomputeEventCompleteness(db, row.id);
        if (score !== null) result.events.recomputed += 1;
      } catch {
        result.events.errored += 1;
      }
    }
  } catch {
    result.events.errored += 1;
  }

  return result;
}
