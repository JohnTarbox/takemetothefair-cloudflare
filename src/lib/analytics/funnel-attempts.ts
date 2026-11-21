/**
 * OPE-1500 — a funnel's `*_submitted` step counts the FIRST submit attempt of a
 * page mount, not every attempt.
 *
 * The beacon numbers attempts (`properties.attempt`, see
 * `makeSubmitAttemptTracker` in src/lib/analytics.ts). Step 2 is latched to
 * first touch, so counting every attempt on step 3 put real-visitor register at
 * interacted→submitted = 125% (7 days to 2026-10-19): every excess row was a
 * retry inside one visit.
 *
 * Rows written before the counter carry no `attempt`. They are counted as
 * attempt 1, which is the old behaviour: history is neither rewritten nor
 * dropped.
 */
import { sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

/** The day the attempt counter shipped. */
export const SUBMIT_ATTEMPT_SINCE = "2026-10-19";

/** Row is not a retry: no `attempt` (any non-submit step, or history) or attempt 1. */
export function firstSubmitAttempt(properties: AnySQLiteColumn): SQL {
  return sql`COALESCE(json_extract(${properties}, '$.attempt'), 1) = 1`;
}

/** Row IS a retry (attempt 2+), for the retry count the funnel read returns. */
export function submitRetry(properties: AnySQLiteColumn): SQL {
  return sql`COALESCE(json_extract(${properties}, '$.attempt'), 1) > 1`;
}
