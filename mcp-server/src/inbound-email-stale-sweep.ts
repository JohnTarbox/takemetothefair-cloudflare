/**
 * Stale-row sweep for inbound_emails.
 *
 * Defense-in-depth for two distinct stuck-row patterns:
 *
 *   (A) "Entrypoint dropped the row" — email() INSERTed but the workflow
 *       create / first-step UPDATE never completed (D1 transient, etc).
 *       Symptom: status='received' AND workflow_instance_id IS NULL.
 *       Original incident: 2026-05-19 D1 transient (commit 10f0e2e).
 *
 *   (B) "Workflow errored mid-flight" — workflow ran past mark-processing
 *       but a later step (send-reply, mark-done, etc) threw past its
 *       retry budget without the run() try/catch covering it, so the
 *       workflow exits and the row never reaches status='replied' or
 *       'failed'. Symptom: status='processing' AND workflow_instance_id
 *       IS NOT NULL. Original incident: 2026-05-20 "Boxboro" stuck row
 *       (CF Email Sending rejected the Message-ID header — root cause
 *       at workflows/inbound-email.ts).
 *
 * Selection criteria (per recovery path):
 *   - received_at < now - STALE_THRESHOLD_SEC (gives the original
 *     workflow time to either succeed or definitively fail before we
 *     interfere)
 *   - received_at > now - MAX_RECOVERY_AGE_SEC (don't try to resurrect
 *     ancient rows; if it's been 24+ hours, the submitter has moved on
 *     and the URL may be stale)
 *   - Pattern (A): status='received' AND workflow_instance_id IS NULL
 *   - Pattern (B): status='processing'   AND workflow_instance_id IS NOT NULL
 *
 * Both patterns get a FRESH workflow created. For pattern (B) this means
 * the original errored instance and the new instance both exist in the
 * CF Workflows dashboard — admin can tell them apart via the
 * workflow_instance_id back-link, which gets overwritten with the new
 * instance's id below.
 *
 * Wired in two places:
 *   1. The every-10-minutes cron in mcp-server/src/index.ts
 *   2. POST /api/admin/workflows/inbound-email/sweep (manual trigger)
 *
 * Idempotency: pattern (A) is naturally idempotent (WHERE
 * workflow_instance_id IS NULL). Pattern (B) requires the workflow
 * itself to advance status off 'processing' on the recovery run — if
 * the original failure mode is deterministic AND not fixed by a deploy
 * in between sweeps, the same row will be picked up again next cycle.
 * Per-row cap at MAX_RECOVERY_ATTEMPTS (drizzle/0082) breaks the loop
 * after 3 cycles: the sweep marks the row terminally failed with
 * reply_kind='sweep-exceeded' and sends a final auto-reply. Cap at
 * MAX_ROWS_PER_SWEEP additionally prevents per-sweep runaway re-creates.
 *
 * Caveats:
 *   - We don't query the Cloudflare Workflows API to check whether the
 *     original instance is actually errored vs. still running. The
 *     STALE_THRESHOLD_SEC delay (15 min for processing rows — see
 *     PROCESSING_STALE_THRESHOLD_SEC) is the proxy.
 */

import { and, eq, gt, isNull, lt, or, isNotNull, sql } from "drizzle-orm";
import { getDb, type Db } from "./db.js";
import { logError } from "./logger.js";
import { inboundEmails } from "./schema.js";
import type { EmailIntent } from "./email-intents.js";
import { buildReply } from "./email-reply-builder.js";

const SOURCE = "mcp:inbound-email:stale-sweep";
const DEFAULT_FROM = "Meet Me at the Fair <notify@meetmeatthefair.com>";

/** Pattern (A) — entrypoint-dropped rows must be at least this old
 *  before sweep considers them. Gives the original workflow time to
 *  complete or definitively error out. Set lower than the workflow's
 *  worst-case latency (Browser Rendering + AI extract + submit ≈ 90s)
 *  wouldn't help; set too high and the user waits too long. */
const STALE_THRESHOLD_SEC = 10 * 60; // 10 minutes

/** Pattern (B) — processing rows. Slightly longer threshold because
 *  these rows had a workflow that DID start; we want to be more sure
 *  it's actually dead before re-creating. The send-reply step's worst
 *  case (3 retries × 10s × exponential backoff + 10s timeout) is ~80s;
 *  the full submit pipeline can take 90s+; 15min comfortably covers
 *  the longest legitimate "still running" state. */
const PROCESSING_STALE_THRESHOLD_SEC = 15 * 60; // 15 minutes

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

/** Per-row cap on sweep recreates. After this many deterministic-failure
 *  cycles the sweep stops recreating the workflow, marks the row
 *  terminally failed, and sends a 'sweep-exceeded' auto-reply so the
 *  submitter isn't left hanging. Root-caused 2026-05-19 hamxposition.org
 *  loop (5 wasted workflow runs on the same NonRetryableError before
 *  mark-done settled). drizzle/0082 added the counter. */
const MAX_RECOVERY_ATTEMPTS = 3;

/** Env subset the sweep needs. DB for SELECT/UPDATE + error_logs; INBOUND_EMAIL
 *  for recreate; EMAIL (optional) for the terminal sweep-exceeded auto-reply
 *  — when EMAIL is unbound we still mark the row failed but skip the reply
 *  with a warn log, matching the workflow's own send-reply behavior. The
 *  actual SELECT/UPDATE flows through the caller-provided `db` so tests
 *  can inject a better-sqlite3-backed Drizzle instance. */
interface SweepEnv {
  DB: D1Database;
  INBOUND_EMAIL: Workflow<{ messageRowId: string; intent: EmailIntent }>;
  EMAIL?: SendEmail;
}

export interface SweepResult {
  /** Number of stale rows the SELECT found. */
  foundCount: number;
  /** Subset of foundCount where INBOUND_EMAIL.create() succeeded. */
  recreatedCount: number;
  /** Subset where create failed (each gets a logError entry too). */
  createFailedCount: number;
  /** Subset where recovery_attempt_n was already >= MAX_RECOVERY_ATTEMPTS
   *  so the sweep skipped the recreate and marked the row terminally
   *  failed instead. drizzle/0082. */
  exceededCount: number;
  /** Per-row outcomes for the admin endpoint to return. */
  rows: Array<{
    messageRowId: string;
    intent: string;
    outcome: "recreated" | "create-failed" | "update-failed" | "exceeded-recovery-cap";
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
    exceededCount: 0,
    rows: [],
  };

  // Time bounds for the stale window. Computed in JS rather than via
  // SQLite's `unixepoch('now', ...)` so the comparison generates a
  // plain parameter-bound query that works identically across D1, D1
  // local, and the better-sqlite3 test harness.
  const nowSec = Math.floor(Date.now() / 1000);
  const receivedStaleUpper = new Date((nowSec - STALE_THRESHOLD_SEC) * 1000);
  const processingStaleUpper = new Date((nowSec - PROCESSING_STALE_THRESHOLD_SEC) * 1000);
  const olderThanLowerBound = new Date((nowSec - MAX_RECOVERY_AGE_SEC) * 1000);

  // Select stale rows from BOTH recovery patterns in one query:
  //   (A) status='received' AND workflow_instance_id IS NULL — entrypoint
  //       dropped the row before workflow create
  //   (B) status='processing' AND workflow_instance_id IS NOT NULL —
  //       workflow started but errored before mark-done
  // Pattern B uses a longer threshold (15m vs 10m) since these rows had
  // a workflow that DID start; we want extra confidence it's dead.
  let stale: Array<{
    id: string;
    intent: string;
    pattern: "received" | "processing";
    recoveryAttemptN: number;
    fromAddress: string;
    subject: string | null;
    messageId: string | null;
    parsedUrl: string | null;
  }>;
  try {
    const rawStale = await db
      .select({
        id: inboundEmails.id,
        intent: inboundEmails.intent,
        status: inboundEmails.status,
        recoveryAttemptN: inboundEmails.recoveryAttemptN,
        fromAddress: inboundEmails.fromAddress,
        subject: inboundEmails.subject,
        messageId: inboundEmails.messageId,
        parsedUrl: inboundEmails.parsedUrl,
      })
      .from(inboundEmails)
      .where(
        and(
          gt(inboundEmails.receivedAt, olderThanLowerBound),
          or(
            and(
              eq(inboundEmails.status, "received"),
              isNull(inboundEmails.workflowInstanceId),
              lt(inboundEmails.receivedAt, receivedStaleUpper)
            ),
            and(
              eq(inboundEmails.status, "processing"),
              isNotNull(inboundEmails.workflowInstanceId),
              lt(inboundEmails.receivedAt, processingStaleUpper)
            )
          )
        )
      )
      .limit(MAX_ROWS_PER_SWEEP);
    stale = rawStale.map((r) => ({
      id: r.id,
      intent: r.intent,
      pattern: r.status === "processing" ? "processing" : "received",
      recoveryAttemptN: r.recoveryAttemptN ?? 0,
      fromAddress: r.fromAddress,
      subject: r.subject,
      messageId: r.messageId,
      parsedUrl: r.parsedUrl,
    }));
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
    // Pre-check the per-row recovery cap. Pattern A rows haven't been
    // recreated yet (counter still 0) so this only ever fires on Pattern B
    // rows where the workflow has already failed deterministically N times.
    if (row.recoveryAttemptN >= MAX_RECOVERY_ATTEMPTS) {
      await terminallyFailRow(db, env, sessionId, row);
      result.exceededCount += 1;
      result.rows.push({
        messageRowId: row.id,
        intent: row.intent,
        outcome: "exceeded-recovery-cap",
      });
      continue;
    }

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

    // Write the new workflow_instance_id back AND increment the recovery
    // counter so the next sweep iteration skips this row AND so the cap
    // check above eventually fires. UPDATE shape differs by pattern:
    //   (A) pattern='received' — guard with WHERE workflow_instance_id
    //       IS NULL so we don't trample a successful racing workflow's
    //       back-link write. Counter still increments — Pattern A is rare
    //       enough that even an over-counted row would still take 3 cycles
    //       to reach the cap.
    //   (B) pattern='processing' — overwrite the OLD (errored) workflow
    //       id with the new one. The original instance still lives in
    //       the CF Workflows dashboard with status=Errored; the back-
    //       link just points at the recovery instance now.
    try {
      const updateQuery = db.update(inboundEmails).set({
        workflowInstanceId,
        recoveryAttemptN: sql`${inboundEmails.recoveryAttemptN} + 1`,
      });
      if (row.pattern === "received") {
        await updateQuery.where(
          and(eq(inboundEmails.id, row.id), isNull(inboundEmails.workflowInstanceId))
        );
      } else {
        await updateQuery.where(eq(inboundEmails.id, row.id));
      }
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

  // Heartbeat: emit a single info-level error_logs row per sweep run so
  // silent cron failures are diagnosable from D1 alone. Without this the
  // sweep source has zero rows on a healthy run — we found out about a
  // misbehaving sweep cycle by querying error_logs and seeing nothing,
  // which is exactly what a healthy run looks like too. (See PR-A's
  // diagnostic for row 2f5f0c74.)
  console.log(
    `[stale-sweep] found=${result.foundCount} recreated=${result.recreatedCount} createFailed=${result.createFailedCount} exceeded=${result.exceededCount}`
  );
  await logError(env.DB, {
    level: "info",
    source: SOURCE,
    message: "stale-sweep run completed",
    sessionId,
    context: {
      foundCount: result.foundCount,
      recreatedCount: result.recreatedCount,
      createFailedCount: result.createFailedCount,
      exceededCount: result.exceededCount,
    },
  }).catch(() => {});
  return result;
}

/**
 * Terminal-fail a row that has exceeded the recovery cap. Writes a final
 * status='failed' / reply_kind='sweep-exceeded' transition and best-effort
 * sends an auto-reply explaining we gave up. The submitter isn't left
 * hanging the way the pre-cap implementation could leave them — a row
 * that errored deterministically would just sit in 'processing' until the
 * 24h MAX_RECOVERY_AGE_SEC bound stopped the sweep from picking it up,
 * with no user-visible notification.
 *
 * The send is fail-soft: any throw (EMAIL unbound, CF rejection, network)
 * still lets us write the row to a terminal state. The submitter losing
 * the auto-reply is bad UX but not as bad as leaving the row indefinitely
 * processing.
 */
async function terminallyFailRow(
  db: Db,
  env: SweepEnv,
  sessionId: string,
  row: {
    id: string;
    intent: string;
    recoveryAttemptN: number;
    fromAddress: string;
    subject: string | null;
    messageId: string | null;
    parsedUrl: string | null;
  }
): Promise<void> {
  const errorMsg = `sweep retry cap exceeded (${row.recoveryAttemptN} attempts)`;
  try {
    await db
      .update(inboundEmails)
      .set({
        status: "failed",
        error: errorMsg,
        replyKind: "sweep-exceeded",
      })
      .where(eq(inboundEmails.id, row.id));
  } catch (err) {
    await logError(env.DB, {
      source: SOURCE,
      message: "terminally-fail UPDATE failed; row left in current state",
      error: err,
      sessionId,
      context: { messageRowId: row.id, recoveryAttemptN: row.recoveryAttemptN },
    });
    // Don't try to send a reply if we couldn't even update the row —
    // sending without the UPDATE would risk double-replies on the next
    // sweep if it picks up the row again.
    return;
  }

  if (!env.EMAIL) {
    await logError(env.DB, {
      level: "warn",
      source: SOURCE,
      message: "EMAIL binding unbound; sweep-exceeded auto-reply skipped",
      sessionId,
      context: { messageRowId: row.id },
    });
    return;
  }

  try {
    const msg = buildReply("sweep-exceeded", row.fromAddress, {
      subject: row.subject ?? "",
      url: row.parsedUrl ?? "",
    });
    const headers: Record<string, string> = {};
    if (row.messageId) {
      headers["In-Reply-To"] = row.messageId;
      headers["References"] = row.messageId;
    }
    await env.EMAIL.send({
      from: msg.from ?? DEFAULT_FROM,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      headers,
    });
  } catch (err) {
    await logError(env.DB, {
      level: "warn",
      source: SOURCE,
      message: "sweep-exceeded auto-reply send failed; row stays terminally failed",
      error: err,
      sessionId,
      context: { messageRowId: row.id },
    });
  }
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
