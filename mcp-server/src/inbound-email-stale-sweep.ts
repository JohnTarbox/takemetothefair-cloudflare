/**
 * Stale-row sweep for inbound_emails.
 *
 * Defense-in-depth for the case where the email() entrypoint inserted
 * an inbound_emails row but the workflow create / first-step UPDATE
 * never completed (D1 transient, Workers AI cold, etc.). Without this
 * sweep, such rows sit silently in status='received' and the submitter
 * never gets an auto-reply.
 *
 * Selection criteria (intentionally narrow to avoid double-create):
 *   - status = 'received' AND workflow_instance_id IS NULL
 *   - received_at < now - STALE_THRESHOLD_SEC (gives the original
 *     workflow time to either succeed or definitively fail before we
 *     interfere)
 *   - received_at > now - MAX_RECOVERY_AGE_SEC (don't try to resurrect
 *     ancient rows; if it's been 24+ hours, the submitter has moved on
 *     and the URL may be stale)
 *
 * For each matched row we call INBOUND_EMAIL.create() and write the new
 * workflow_instance_id back. The mark-processing step (now fail-soft
 * after 2026-05-19 incident — see workflows/inbound-email.ts) then runs
 * the standard pipeline.
 *
 * Wired in two places:
 *   1. The every-10-minutes cron in mcp-server/src/index.ts (automatic
 *      recovery — cron expression "*\/10 * * * *", escaped here so JSDoc
 *      parsing doesn't choke on the inline close-comment)
 *   2. POST /api/admin/workflows/inbound-email/sweep (manual trigger)
 *
 * Idempotency: the WHERE workflow_instance_id IS NULL guard means once
 * a sweep run creates a workflow for a row, subsequent sweeps skip it.
 * The new workflow's mark-processing step (or this function's own
 * post-create UPDATE) sets workflow_instance_id before the next sweep
 * fires.
 *
 * Caveats:
 *   - Rows where workflow_instance_id IS NOT NULL but status='received'
 *     are NOT picked up. That edge case means the original workflow's
 *     mark-processing succeeded enough to write the back-link but then
 *     the workflow errored mid-pipeline without recording status. Rare;
 *     handle in a follow-up if it shows up in production data.
 *   - We don't query the Cloudflare Workflows API to check whether the
 *     original instance is actually errored vs. still running. The
 *     STALE_THRESHOLD_SEC delay (10 min) is the proxy — at that age,
 *     a still-running workflow is almost certainly stuck.
 */

import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { getDb, type Db } from "./db.js";
import { logError } from "./logger.js";
import { inboundEmails } from "./schema.js";
import type { EmailIntent } from "./email-intents.js";

const SOURCE = "mcp:inbound-email:stale-sweep";

/** Rows must be at least this old before sweep considers them. Gives
 *  the original workflow time to complete or definitively error out.
 *  Set lower than the workflow's worst-case latency (Browser Rendering
 *  + AI extract + submit ≈ 90s) wouldn't help; set too high and the
 *  user waits too long for an auto-reply.
 */
const STALE_THRESHOLD_SEC = 10 * 60; // 10 minutes

/** Don't try to recover rows older than this. After 24h the submitter
 *  has moved on and the source URL may have changed; better to leave
 *  the row in 'received' as a permanent admin-review artifact than
 *  fire a stale auto-reply that confuses the sender.
 */
const MAX_RECOVERY_AGE_SEC = 24 * 60 * 60; // 24 hours

/** Cap per sweep run. Large enough to drain a backlog from a
 *  multi-hour D1 outage, small enough that a runaway sweep can't
 *  saturate Workflows quota. */
const MAX_ROWS_PER_SWEEP = 50;

/** Env subset the sweep needs. D1 is used for error_logs writes; the
 *  actual SELECT/UPDATE flows through the caller-provided `db` so tests
 *  can inject a better-sqlite3-backed Drizzle instance. */
interface SweepEnv {
  DB: D1Database;
  INBOUND_EMAIL: Workflow<{ messageRowId: string; intent: EmailIntent }>;
}

export interface SweepResult {
  /** Number of stale rows the SELECT found. */
  foundCount: number;
  /** Subset of foundCount where INBOUND_EMAIL.create() succeeded. */
  recreatedCount: number;
  /** Subset where create failed (each gets a logError entry too). */
  createFailedCount: number;
  /** Per-row outcomes for the admin endpoint to return. */
  rows: Array<{
    messageRowId: string;
    intent: string;
    outcome: "recreated" | "create-failed" | "update-failed";
    newWorkflowInstanceId?: string;
    error?: string;
  }>;
}

export async function runInboundEmailStaleSweep(db: Db, env: SweepEnv): Promise<SweepResult> {
  const sessionId = crypto.randomUUID();
  const result: SweepResult = {
    foundCount: 0,
    recreatedCount: 0,
    createFailedCount: 0,
    rows: [],
  };

  // Time bounds for the stale window. Computed in JS rather than via
  // SQLite's `unixepoch('now', ...)` so the comparison generates a
  // plain parameter-bound query that works identically across D1, D1
  // local, and the better-sqlite3 test harness.
  const nowSec = Math.floor(Date.now() / 1000);
  const olderThanUpperBound = new Date((nowSec - STALE_THRESHOLD_SEC) * 1000);
  const olderThanLowerBound = new Date((nowSec - MAX_RECOVERY_AGE_SEC) * 1000);

  // Select stale rows. SELECT-only — the actual workflow recreate +
  // back-link write happens per row below.
  let stale: Array<{ id: string; intent: string }>;
  try {
    stale = await db
      .select({ id: inboundEmails.id, intent: inboundEmails.intent })
      .from(inboundEmails)
      .where(
        and(
          eq(inboundEmails.status, "received"),
          isNull(inboundEmails.workflowInstanceId),
          lt(inboundEmails.receivedAt, olderThanUpperBound),
          gt(inboundEmails.receivedAt, olderThanLowerBound)
        )
      )
      .limit(MAX_ROWS_PER_SWEEP);
  } catch (err) {
    await logError(env.DB, {
      source: SOURCE,
      message: "stale-sweep SELECT failed; aborting",
      error: err,
      sessionId,
    });
    return result;
  }

  result.foundCount = stale.length;
  if (stale.length === 0) {
    return result;
  }

  // Per-row workflow recreate. Sequential (not Promise.all) so we don't
  // hammer Workflows quota on a backlog; volume is expected to be tiny
  // anyway.
  for (const row of stale) {
    const intent = row.intent as EmailIntent;
    let workflowInstanceId: string;
    try {
      const instance = await env.INBOUND_EMAIL.create({
        params: { messageRowId: row.id, intent },
        retention: { successRetention: "7 days", errorRetention: "7 days" },
      });
      workflowInstanceId = instance.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.createFailedCount += 1;
      result.rows.push({
        messageRowId: row.id,
        intent: row.intent,
        outcome: "create-failed",
        error: msg,
      });
      await logError(env.DB, {
        source: SOURCE,
        message: "stale-sweep INBOUND_EMAIL.create failed",
        error: err,
        sessionId,
        context: { messageRowId: row.id, intent: row.intent },
      });
      continue;
    }

    // Write the new workflow_instance_id back so the next sweep
    // iteration skips this row. WHERE clause double-guards against a
    // racing successful original workflow.
    try {
      await db
        .update(inboundEmails)
        .set({ workflowInstanceId })
        .where(and(eq(inboundEmails.id, row.id), isNull(inboundEmails.workflowInstanceId)));
      result.recreatedCount += 1;
      result.rows.push({
        messageRowId: row.id,
        intent: row.intent,
        outcome: "recreated",
        newWorkflowInstanceId: workflowInstanceId,
      });
    } catch (err) {
      // Workflow IS created and running; we just couldn't record the
      // back-link. The workflow's own mark-processing step will write
      // it. Log a warning and treat as success.
      result.recreatedCount += 1;
      result.rows.push({
        messageRowId: row.id,
        intent: row.intent,
        outcome: "update-failed",
        newWorkflowInstanceId: workflowInstanceId,
        error: err instanceof Error ? err.message : String(err),
      });
      await logError(env.DB, {
        level: "warn",
        source: SOURCE,
        message: "stale-sweep back-link UPDATE failed; workflow created OK",
        error: err,
        sessionId,
        context: { messageRowId: row.id, workflowInstanceId },
      });
    }
  }

  console.log(
    `[stale-sweep] found=${result.foundCount} recreated=${result.recreatedCount} createFailed=${result.createFailedCount}`
  );
  return result;
}

/** Thin wrapper for the cron handler — matches the existing
 *  runScheduledX naming + try/catch pattern in src/index.ts. Builds the
 *  Drizzle Db from env.DB before delegating; tests skip this wrapper
 *  and call runInboundEmailStaleSweep directly with a test-built Db. */
export async function runScheduledInboundEmailStaleSweep(env: SweepEnv): Promise<void> {
  try {
    const db = getDb(env.DB);
    await runInboundEmailStaleSweep(db, env);
  } catch (error) {
    await logError(env.DB, {
      source: `${SOURCE}:scheduled`,
      message: "scheduled stale-sweep threw",
      error,
    });
  }
}
