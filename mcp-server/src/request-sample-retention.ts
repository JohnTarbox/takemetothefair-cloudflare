/**
 * OPE-971 — request_samples retention, on a schedule.
 *
 * Before this, the 60-day window was enforced by a 1% dice roll inside the
 * middleware's sample WRITE (src/lib/request-sampling.ts): retention depended on
 * how much traffic arrived after a row rather than on the row's age, every
 * failure was swallowed by the write's catch, and turning sampling off would
 * have frozen the table with its contents. Measured 2026-09-13 before the
 * change: 103,371 rows, oldest 2026-07-15 18:14Z, **5 rows past the window** —
 * the lag was real if small.
 *
 * Now: a daily run deletes in bounded batches until a batch comes back short,
 * then records what it did and what the oldest remaining row is. The run
 * stamp (`agent_heartbeats`) is what the heartbeat probe watches, because the
 * deleted count is legitimately 0 on most days.
 *
 * The stamp is written ONLY when the run had no errors. Stamping a failed run
 * kept the probe green while the prune was broken — the very "a control that
 * cannot fail" shape this replaced (found by OPE-993's sibling module, 2026-09-13).
 */
import { REQUEST_SAMPLE_RETENTION_DAYS } from "@takemetothefair/constants";
import { inArray, lt, sql } from "drizzle-orm";
import { agentHeartbeats, requestSamples } from "./schema.js";
import type { Db } from "./db.js";
import { logError } from "./logger.js";

export const REQUEST_SAMPLE_RETENTION_CODE = "watchdog:request-sample-retention";
const SOURCE = "mcp:request-sample-retention";

/** Rows per DELETE. The id list is a subquery, so no ids are bound as params. */
export const RETENTION_BATCH = 500;
/** Hard stop so a runaway loop cannot eat the cron's time budget. */
export const RETENTION_MAX_BATCHES = 200;

export interface RetentionResult {
  cutoff: string;
  deleted: number;
  batches: number;
  /** True when MAX_BATCHES stopped the loop with rows still past the cutoff. */
  capped: boolean;
  oldestRemaining: string | null;
  /** True when the oldest remaining row is still older than the cutoff. */
  windowExceeded: boolean;
  errors: number;
}

export async function runRequestSampleRetention(
  db: Db,
  opts: { now?: Date; cutoff?: Date; batch?: number; maxBatches?: number } = {}
): Promise<RetentionResult> {
  const now = opts.now ?? new Date();
  const cutoff =
    opts.cutoff ?? new Date(now.getTime() - REQUEST_SAMPLE_RETENTION_DAYS * 86_400_000);
  const batch = opts.batch ?? RETENTION_BATCH;
  const maxBatches = opts.maxBatches ?? RETENTION_MAX_BATCHES;

  const result: RetentionResult = {
    cutoff: cutoff.toISOString(),
    deleted: 0,
    batches: 0,
    capped: false,
    oldestRemaining: null,
    windowExceeded: false,
    errors: 0,
  };

  try {
    for (;;) {
      if (result.batches >= maxBatches) {
        result.capped = true;
        break;
      }
      const doomed = db
        .select({ id: requestSamples.id })
        .from(requestSamples)
        .where(lt(requestSamples.timestamp, cutoff))
        .limit(batch);
      const gone = await db
        .delete(requestSamples)
        .where(inArray(requestSamples.id, doomed))
        .returning({ id: requestSamples.id });
      result.batches++;
      result.deleted += gone.length;
      if (gone.length < batch) break;
    }
  } catch (error) {
    result.errors++;
    await logError(db, { message: "request_samples prune failed", error, source: SOURCE }).catch(
      () => {}
    );
  }

  try {
    const [row] = await db
      .select({ oldest: sql<number | null>`MIN(${requestSamples.timestamp})` })
      .from(requestSamples);
    if (row?.oldest != null) {
      const oldest = new Date(Number(row.oldest) * 1000);
      result.oldestRemaining = oldest.toISOString();
      result.windowExceeded = oldest.getTime() < cutoff.getTime();
    }
  } catch (error) {
    result.errors++;
    await logError(db, {
      message: "request_samples oldest-row read failed",
      error,
      source: SOURCE,
    }).catch(() => {});
  }

  const note =
    `deleted=${result.deleted} batches=${result.batches} capped=${result.capped} ` +
    `oldest=${result.oldestRemaining ?? "none"} cutoff=${result.cutoff} errors=${result.errors}`;

  // A retention control has to be SEEN working: a window still exceeded after
  // the run is reported, not left for someone to notice.
  if (result.windowExceeded || result.errors > 0) {
    await logError(db, {
      level: "warn",
      message: `request_samples retention incomplete: ${note}`,
      source: SOURCE,
      context: { ...result },
    }).catch(() => {});
  }

  // A failed run is logged above and NOT stamped, so the probe goes red.
  if (result.errors > 0) return result;

  try {
    await db
      .insert(agentHeartbeats)
      .values({
        id: crypto.randomUUID(),
        agentCode: REQUEST_SAMPLE_RETENTION_CODE,
        kind: "watchdog",
        lastSeenAt: now,
        note,
      })
      .onConflictDoUpdate({
        target: agentHeartbeats.agentCode,
        set: { lastSeenAt: now, kind: "watchdog", note },
      });
  } catch (error) {
    result.errors++;
    await logError(db, {
      message: "request_samples run-stamp write failed",
      error,
      source: SOURCE,
    }).catch(() => {});
  }
  return result;
}
