/**
 * OPE-702 — the elapsed-but-never-corroborated event population, made countable.
 *
 * ⚠️ READ THIS BEFORE "FIXING" THE NUMBER. These rows are CORRECT, not stranded.
 *
 * OPE-675 asked whether the missing `TENTATIVE → OCCURRED` edge was an oversight
 * and answered no, with the reasoning recorded beside `LIFECYCLE_TRANSITIONS`:
 * for an event nobody confirmed took place, the right lifecycle is TENTATIVE —
 * over, and never corroborated. `OCCURRED` asserts it happened and `NO_SHOW`
 * asserts it did not; both are claims nobody made. Sweeping this count to zero
 * would manufacture ~165 such claims.
 *
 * That is why this reports a POPULATION and deliberately carries no `rule:`
 * field. Every other entry in the data-health report is a fault whose target is
 * zero. This one's target is not zero, and treating it as a fault is the single
 * thing that must not happen to it.
 *
 * ── Why count it at all ───────────────────────────────────────────────────
 *
 * Because nothing did. The 2026-08-19 marquee watchlist asked for the number
 * and it went unrun for twelve days. A population that grows by ~54/month, is
 * PUBLICLY SERVED (`PUBLIC_LIFECYCLE_STATUSES` includes TENTATIVE, so an
 * APPROVED elapsed row renders), and is measured by nobody is the exact shape
 * this codebase keeps rediscovering — OPE-547's `unevaluated`, OPE-713's
 * `producerClassExcluded`.
 *
 * ── The buckets are separate because they are different questions ─────────
 *
 * The tidy total overstates the real one by 27%. A season row
 * (`sandy-river-farmers-market-2026`) has a past `start_date` and is still
 * running; a NULL `end_date` cannot be judged from the row at all. Counting on
 * `start_date` alone would report 209 where the answer is 165.
 *
 * ── The only legitimate way to reduce it ──────────────────────────────────
 *
 * Per-event corroboration: establish that the event happened, then take the
 * route `describeLifecycleRefusal` already offers (TENTATIVE → SCHEDULED →
 * OCCURRED) knowing what the intermediate state asserts. Never in bulk.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { events } from "../schema.js";
import type { Db } from "../db.js";

export const ELAPSED_TENTATIVE_NOT_A_FAULT =
  "TENTATIVE on an elapsed event is the CORRECT state (OPE-675): over, and never " +
  "corroborated. Do NOT sweep this to zero — promoting to OCCURRED or NO_SHOW asserts " +
  "a claim nobody made. Reduce it only by corroborating individual events.";

export interface ElapsedTentative {
  not_a_fault: string;
  truly_elapsed: number;
  publicly_served: number;
  still_running: number;
  end_date_null: number;
  elapsed_within_30d: number;
  oldest_elapsed_at: string | null;
}

export async function readElapsedTentative(db: Db, now = new Date()): Promise<ElapsedTentative> {
  const nowSecs = Math.floor(now.getTime() / 1000);
  const thirtyDaysAgo = nowSecs - 30 * 24 * 60 * 60;

  const [row] = await db
    .select({
      truly_elapsed: sql<number>`SUM(CASE WHEN ${events.endDate} IS NOT NULL AND ${events.endDate} < ${nowSecs} THEN 1 ELSE 0 END)`,
      // The subset a visitor can actually reach.
      publicly_served: sql<number>`SUM(CASE WHEN ${events.endDate} IS NOT NULL AND ${events.endDate} < ${nowSecs} AND ${events.status} = 'APPROVED' THEN 1 ELSE 0 END)`,
      // NOT stranded — in progress. Season and multi-day rows.
      still_running: sql<number>`SUM(CASE WHEN ${events.endDate} IS NOT NULL AND ${events.endDate} >= ${nowSecs} AND ${events.startDate} < ${nowSecs} THEN 1 ELSE 0 END)`,
      // A different question, not bulk-judgeable from the row.
      end_date_null: sql<number>`SUM(CASE WHEN ${events.endDate} IS NULL AND ${events.startDate} < ${nowSecs} THEN 1 ELSE 0 END)`,
      // The regeneration rate — this season's flow vs historical debt.
      elapsed_within_30d: sql<number>`SUM(CASE WHEN ${events.endDate} IS NOT NULL AND ${events.endDate} < ${nowSecs} AND ${events.endDate} >= ${thirtyDaysAgo} THEN 1 ELSE 0 END)`,
      oldest_elapsed_at: sql<
        number | null
      >`MIN(CASE WHEN ${events.endDate} IS NOT NULL AND ${events.endDate} < ${nowSecs} THEN ${events.endDate} END)`,
    })
    .from(events)
    .where(and(eq(events.lifecycleStatus, "TENTATIVE"), isNull(events.mergedInto)));

  return {
    not_a_fault: ELAPSED_TENTATIVE_NOT_A_FAULT,
    truly_elapsed: row?.truly_elapsed ?? 0,
    publicly_served: row?.publicly_served ?? 0,
    still_running: row?.still_running ?? 0,
    end_date_null: row?.end_date_null ?? 0,
    elapsed_within_30d: row?.elapsed_within_30d ?? 0,
    oldest_elapsed_at: row?.oldest_elapsed_at
      ? new Date(row.oldest_elapsed_at * 1000).toISOString()
      : null,
  };
}
