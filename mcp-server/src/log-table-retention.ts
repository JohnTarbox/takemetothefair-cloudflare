/**
 * OPE-993 — error_logs and indexnow_submissions retention, on a schedule.
 *
 * Before this, both 30-day windows were enforced by a 1% dice roll inside the
 * table's own WRITE path (src/lib/logger.ts, src/lib/indexnow.ts): retention
 * depended on how many writes arrived rather than on a row's age, and a
 * failed delete was swallowed by the write's catch — nothing could tell a
 * working prune from a dead one. Measured in prod 2026-09-13 22:48Z, before
 * the change:
 *   error_logs            4,113 rows, oldest 2026-08-13 18:00Z, 288 past 30d
 *   indexnow_submissions  1,004 rows, oldest 2026-08-14 21:01Z,   2 past 30d
 *
 * Now: the MCP 06:00Z cron deletes in bounded batches (id SUBQUERY — no ids
 * are ever bound, so D1's 100-param cap cannot be reached) until a batch
 * comes back short, logs what it did at level info, and warns when the batch
 * cap stopped it with rows still past the cutoff.
 *
 * Shape copied from request-sample-retention.ts (OPE-971) with ONE deliberate
 * difference: a run whose delete throws does NOT write its run stamp. The
 * heartbeat probe watches that stamp, so a broken delete turns the probe red
 * inside its window instead of reporting a healthy run that removed nothing.
 */
import {
  ERROR_LOG_RETENTION_DAYS,
  INDEXNOW_SUBMISSION_RETENTION_DAYS,
} from "@takemetothefair/constants";
import { inArray, lt, sql } from "drizzle-orm";
import { agentHeartbeats, errorLogs, indexnowSubmissions } from "./schema.js";
import type { Db } from "./db.js";
import { logError } from "./logger.js";

export const ERROR_LOG_RETENTION_CODE = "watchdog:error-log-retention";
export const INDEXNOW_SUBMISSION_RETENTION_CODE = "watchdog:indexnow-submission-retention";

/** Rows per DELETE. The id list is a subquery, so no ids are bound as params. */
export const LOG_RETENTION_BATCH = 500;
/** Hard stop so a runaway loop cannot eat the cron's time budget. */
export const LOG_RETENTION_MAX_BATCHES = 200;

export interface LogRetentionOptions {
  now?: Date;
  cutoff?: Date;
  batch?: number;
  maxBatches?: number;
}

export interface LogRetentionResult {
  table: string;
  cutoff: string;
  deleted: number;
  batches: number;
  /** True when MAX_BATCHES stopped the loop with rows still past the cutoff. */
  capped: boolean;
  oldestRemaining: string | null;
  /** True when the oldest remaining row is still older than the cutoff. */
  windowExceeded: boolean;
  /** False when the prune threw — the run stamp is then NOT written. */
  ok: boolean;
  /** True only when the run stamp was written. */
  stamped: boolean;
}

interface RetentionSpec {
  table: string;
  code: string;
  source: string;
  days: number;
  /** Delete up to `batch` rows older than `cutoff`; returns rows deleted. */
  deleteBatch: (db: Db, cutoff: Date, batch: number) => Promise<number>;
  /** MIN(timestamp) in unix SECONDS, or null on an empty table. */
  oldestSeconds: (db: Db) => Promise<number | null>;
}

async function runLogTableRetention(
  db: Db,
  spec: RetentionSpec,
  opts: LogRetentionOptions
): Promise<LogRetentionResult> {
  const now = opts.now ?? new Date();
  const cutoff = opts.cutoff ?? new Date(now.getTime() - spec.days * 86_400_000);
  const batch = opts.batch ?? LOG_RETENTION_BATCH;
  const maxBatches = opts.maxBatches ?? LOG_RETENTION_MAX_BATCHES;

  const result: LogRetentionResult = {
    table: spec.table,
    cutoff: cutoff.toISOString(),
    deleted: 0,
    batches: 0,
    capped: false,
    oldestRemaining: null,
    windowExceeded: false,
    ok: false,
    stamped: false,
  };

  try {
    for (;;) {
      if (result.batches >= maxBatches) {
        result.capped = true;
        break;
      }
      const gone = await spec.deleteBatch(db, cutoff, batch);
      result.batches++;
      result.deleted += gone;
      if (gone < batch) break;
    }
    const oldest = await spec.oldestSeconds(db);
    if (oldest != null) {
      const d = new Date(Number(oldest) * 1000);
      result.oldestRemaining = d.toISOString();
      result.windowExceeded = d.getTime() < cutoff.getTime();
    }
    result.ok = true;
  } catch (error) {
    // No stamp on this path: the probe must see a broken prune as silence.
    await logError(db, {
      message: `${spec.table} retention failed (run NOT stamped): deleted=${result.deleted} batches=${result.batches} cutoff=${result.cutoff}`,
      error,
      source: spec.source,
      context: { ...result },
    }).catch(() => {});
    return result;
  }

  const note =
    `deleted=${result.deleted} batches=${result.batches} capped=${result.capped} ` +
    `oldest=${result.oldestRemaining ?? "none"} cutoff=${result.cutoff}`;

  await logError(db, {
    level: "info",
    message: `${spec.table} retention: ${note}`,
    source: spec.source,
    context: { ...result },
  }).catch(() => {});

  if (result.capped) {
    await logError(db, {
      level: "warn",
      message: `${spec.table} retention incomplete — batch cap reached (windowExceeded=${result.windowExceeded}): ${note}`,
      source: spec.source,
      context: { ...result },
    }).catch(() => {});
  }

  try {
    await db
      .insert(agentHeartbeats)
      .values({
        id: crypto.randomUUID(),
        agentCode: spec.code,
        kind: "watchdog",
        lastSeenAt: now,
        note,
      })
      .onConflictDoUpdate({
        target: agentHeartbeats.agentCode,
        set: { lastSeenAt: now, kind: "watchdog", note },
      });
    result.stamped = true;
  } catch (error) {
    await logError(db, {
      message: `${spec.table} retention run-stamp write failed`,
      error,
      source: spec.source,
    }).catch(() => {});
  }
  return result;
}

const ERROR_LOG_SPEC: RetentionSpec = {
  table: "error_logs",
  code: ERROR_LOG_RETENTION_CODE,
  source: "mcp:error-log-retention",
  days: ERROR_LOG_RETENTION_DAYS,
  deleteBatch: async (db, cutoff, batch) => {
    const doomed = db
      .select({ id: errorLogs.id })
      .from(errorLogs)
      .where(lt(errorLogs.timestamp, cutoff))
      .limit(batch);
    const gone = await db
      .delete(errorLogs)
      .where(inArray(errorLogs.id, doomed))
      .returning({ id: errorLogs.id });
    return gone.length;
  },
  oldestSeconds: async (db) => {
    const [row] = await db
      .select({ oldest: sql<number | null>`MIN(${errorLogs.timestamp})` })
      .from(errorLogs);
    return row?.oldest ?? null;
  },
};

const INDEXNOW_SUBMISSION_SPEC: RetentionSpec = {
  table: "indexnow_submissions",
  code: INDEXNOW_SUBMISSION_RETENTION_CODE,
  source: "mcp:indexnow-submission-retention",
  days: INDEXNOW_SUBMISSION_RETENTION_DAYS,
  deleteBatch: async (db, cutoff, batch) => {
    const doomed = db
      .select({ id: indexnowSubmissions.id })
      .from(indexnowSubmissions)
      .where(lt(indexnowSubmissions.timestamp, cutoff))
      .limit(batch);
    const gone = await db
      .delete(indexnowSubmissions)
      .where(inArray(indexnowSubmissions.id, doomed))
      .returning({ id: indexnowSubmissions.id });
    return gone.length;
  },
  oldestSeconds: async (db) => {
    const [row] = await db
      .select({ oldest: sql<number | null>`MIN(${indexnowSubmissions.timestamp})` })
      .from(indexnowSubmissions);
    return row?.oldest ?? null;
  },
};

/** Daily: prune error_logs rows older than ERROR_LOG_RETENTION_DAYS (30). */
export function runErrorLogRetention(
  db: Db,
  opts: LogRetentionOptions = {}
): Promise<LogRetentionResult> {
  return runLogTableRetention(db, ERROR_LOG_SPEC, opts);
}

/** Daily: prune indexnow_submissions older than INDEXNOW_SUBMISSION_RETENTION_DAYS (30). */
export function runIndexNowSubmissionRetention(
  db: Db,
  opts: LogRetentionOptions = {}
): Promise<LogRetentionResult> {
  return runLogTableRetention(db, INDEXNOW_SUBMISSION_SPEC, opts);
}
