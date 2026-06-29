/**
 * OPE-17 (2026-06-29) — inbound-email exception rails.
 *
 * The server-side "rails" half of the inbound-email exception lane — direct
 * sibling of OPE-13 (roster rails) + OPE-15 (roster queue-non-empty notice).
 * The judgment half stays an interactive analyst task (OPE-16).
 *
 * The auto-pipeline already handles clean submissions end to end and classifies
 * every row. What was missing is a DEFINED human-triage queue over the residue,
 * auto-disposition of the obvious buckets, and a notification. This module is
 * all three, run on the daily 06:00 UTC sweep:
 *
 *   1. Reconcile (the rails):
 *      a. Auto-correct ALREADY-HANDLED rows — status='failed' but
 *         resulting_event_id IS NOT NULL (e.g. a dedup hit that later errored,
 *         or the GLS row salvaged out-of-band). Flip → 'salvaged' so they never
 *         surface in the triage queue.
 *      b. Auto-dispose NON-EVENT noise — status='failed' with an unambiguous
 *         non-submission classified_intent ('spam'/'unsubscribe'). Flip →
 *         'rejected' (a NEW, reversible terminal state — never a hard delete; an
 *         operator can flip status back). Conservative on purpose: 'unclear' is
 *         NOT auto-rejected (it could be a misclassified real event), and it's
 *         already excluded from the queue by the intent filter below.
 *
 *   2. Count the TRUE salvage candidates — status='failed', resulting_event_id
 *      IS NULL, and a real-event-attempt intent (new_event / submit). This is
 *      the queue the analyst drains. notify@ blog-mention rows are 'waiting'
 *      (not 'failed'), so they're excluded structurally — no special-case.
 *
 *   3. Notify (the OPE-15 analog) — when the queue is non-empty AND changed
 *      since the last notice, email the operator once. Debounced ≤1/day via
 *      inbound_exception_notice_state (drizzle/0136).
 *
 * Dispatch reuses ALERT_EMAIL_TECHNICAL + EMAIL_JOBS (same channel as the roster
 * notice / canaries). Cosmetic-failsoft: every DB op catches its own error and
 * logs, so a bad row never aborts the sibling crons.
 */
import { and, eq, isNull, isNotNull, inArray, desc, sql } from "drizzle-orm";
import { inboundEmails, inboundExceptionNoticeState } from "@takemetothefair/db-schema";
import type { Env } from "./index.js";
import { getDb } from "./db.js";
import { logError } from "./logger.js";

const SOURCE = "mcp:schedule:inbound-exception-notice";

/** Constant PK for the single debounce row. */
const NOTICE_KEY = "inbound_exception_notice";

/** How many sample rows to include in the notice body. */
const SAMPLE_LIMIT = 5;

/** Routed-intent values that represent a real event-submission attempt — the
 *  only rows a human should salvage. (`new_event` is the classifier value;
 *  `submit` is the routed pipeline value — both appear on inbound_emails.intent.) */
const SALVAGE_INTENTS = ["new_event", "submit"] as const;

/** Classified intents that are unambiguously NOT event submissions and safe to
 *  auto-dispose to the reversible 'rejected' state. Deliberately excludes
 *  'unclear' (ambiguous — could be a misclassified real event). */
const NON_EVENT_INTENTS = ["spam", "unsubscribe"] as const;

/** The TRUE salvage-candidate predicate — the human-triage queue. Exported so
 *  the count query, the sample query, and an optional `list_inbound_exceptions`
 *  MCP tool all share one source of truth. */
export const salvageCandidateWhere = and(
  eq(inboundEmails.status, "failed"),
  isNull(inboundEmails.resultingEventId),
  inArray(inboundEmails.intent, [...SALVAGE_INTENTS])
);

/** Format a Date as `YYYY-MM-DD` in UTC — matches the once-per-day comparison. */
function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Pure decision gate — exported for unit tests. Identical shape to OPE-15's
 * decideRosterNotice: fire only when the queue is non-empty, not already
 * notified today, and changed since the last notice.
 */
export function decideInboundExceptionNotice(
  count: number,
  lastNoticeDate: string | null,
  lastQueueCount: number | null,
  today: string
): boolean {
  if (count <= 0) return false;
  if (lastNoticeDate === today) return false;
  if (lastQueueCount !== null && lastQueueCount === count) return false;
  return true;
}

/** Minimal HTML-escape for subjects/addresses interpolated into the email. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface ReconcileResult {
  autoSalvaged: number;
  autoRejected: number;
}

/**
 * The rails. Idempotent: each UPDATE only matches rows still in the bad state,
 * so re-running daily is a no-op once converged. Returns per-rail counts for the
 * heartbeat log. Failsoft per rail — a failure in one logs and the other still
 * runs.
 */
export async function reconcileInboundExceptions(
  db: ReturnType<typeof getDb>,
  now: Date,
  dbBinding: Env["DB"]
): Promise<ReconcileResult> {
  const result: ReconcileResult = { autoSalvaged: 0, autoRejected: 0 };

  // (a) Already-handled: failed but has a resulting event → salvaged.
  try {
    const where = and(
      eq(inboundEmails.status, "failed"),
      isNotNull(inboundEmails.resultingEventId)
    );
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(inboundEmails)
      .where(where);
    if (n > 0) {
      await db.update(inboundEmails).set({ status: "salvaged" }).where(where);
      result.autoSalvaged = n;
    }
  } catch (error) {
    await logError(dbBinding, {
      source: SOURCE,
      message: "[inbound-exception] auto-salvage reconcile failed",
      error,
    });
  }

  // (b) Non-event noise: failed + unambiguous non-submission intent → rejected
  //     (reversible; never a hard delete).
  try {
    const where = and(
      eq(inboundEmails.status, "failed"),
      inArray(inboundEmails.classifiedIntent, [...NON_EVENT_INTENTS])
    );
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(inboundEmails)
      .where(where);
    if (n > 0) {
      await db.update(inboundEmails).set({ status: "rejected" }).where(where);
      result.autoRejected = n;
    }
  } catch (error) {
    await logError(dbBinding, {
      source: SOURCE,
      message: "[inbound-exception] auto-reject reconcile failed",
      error,
    });
  }

  return result;
}

/**
 * Main entry point. Reconcile the rails, then notify if the triage queue is
 * non-empty and changed. Exported for index.ts and unit tests.
 */
export async function runInboundExceptionNotice(env: Env): Promise<void> {
  const now = new Date();
  const today = utcDayKey(now);
  const db = getDb(env.DB);

  // Rails first, so the count reflects the post-reconciliation queue.
  const reconciled = await reconcileInboundExceptions(db, now, env.DB);

  // Count the true salvage candidates.
  let count = 0;
  try {
    const rows = await db
      .select({ n: sql<number>`count(*)` })
      .from(inboundEmails)
      .where(salvageCandidateWhere);
    count = rows[0]?.n ?? 0;
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "[inbound-exception] count query failed",
      error,
    });
    return;
  }

  // Read debounce state.
  let lastNoticeDate: string | null = null;
  let lastQueueCount: number | null = null;
  try {
    const stateRow = await db.query.inboundExceptionNoticeState.findFirst({
      where: eq(inboundExceptionNoticeState.id, NOTICE_KEY),
    });
    if (stateRow) {
      lastNoticeDate = stateRow.lastNoticeDate;
      lastQueueCount = stateRow.lastQueueCount;
    }
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "[inbound-exception] debounce read failed",
      error,
    });
    return;
  }

  if (!decideInboundExceptionNotice(count, lastNoticeDate, lastQueueCount, today)) {
    console.log(
      `[cron] inbound-exception-notice skip — candidates=${count} ` +
        `autoSalvaged=${reconciled.autoSalvaged} autoRejected=${reconciled.autoRejected} ` +
        `lastNoticeDate=${lastNoticeDate ?? "never"} lastCount=${lastQueueCount ?? "n/a"} today=${today}`
    );
    return;
  }

  // Fire path: sample subjects (most-recent first).
  let samples: { subject: string | null; fromAddress: string }[] = [];
  try {
    samples = await db
      .select({ subject: inboundEmails.subject, fromAddress: inboundEmails.fromAddress })
      .from(inboundEmails)
      .where(salvageCandidateWhere)
      .orderBy(desc(inboundEmails.receivedAt))
      .limit(SAMPLE_LIMIT);
  } catch (error) {
    await logError(env.DB, {
      level: "warn",
      source: SOURCE,
      message: "[inbound-exception] sample query failed; sending count-only notice",
      error,
    });
  }

  const noun = count === 1 ? "email" : "emails";
  const subject = `📥 Inbound-email triage: ${count} ${noun} need a human to salvage`;
  const sampleLines = samples.map(
    (s) => ` • ${s.subject?.trim() || "(no subject)"} — ${s.fromAddress}`
  );
  const sampleBlock = sampleLines.length ? `Sample:\n${sampleLines.join("\n")}\n\n` : "";
  const textBody =
    `${count} inbound ${noun} are in the human-triage exception queue — failed extraction, ` +
    `no event created, and a real event-submission intent. They need a human to salvage.\n\n` +
    sampleBlock +
    `Drain them interactively (the OPE-16 triage task). This run also auto-corrected ` +
    `${reconciled.autoSalvaged} already-handled row(s) → salvaged and auto-disposed ` +
    `${reconciled.autoRejected} non-event row(s) → rejected (reversible).\n`;
  const sampleHtml = sampleLines.length
    ? `<p>Sample:</p><ul>${samples
        .map(
          (s) =>
            `<li>${escapeHtml(s.subject?.trim() || "(no subject)")} — ${escapeHtml(s.fromAddress)}</li>`
        )
        .join("")}</ul>`
    : "";
  const htmlBody =
    `<p><strong>📥 Inbound-email triage queue</strong> — <strong>${count}</strong> ${noun} ` +
    `(failed extraction, no event created, real submission intent) need a human to salvage.</p>` +
    sampleHtml +
    `<p>Drain them interactively (the OPE-16 triage task). This run also auto-corrected ` +
    `<strong>${reconciled.autoSalvaged}</strong> already-handled row(s) → salvaged and auto-disposed ` +
    `<strong>${reconciled.autoRejected}</strong> non-event row(s) → rejected (reversible).</p>`;

  const alertEmail = env.ALERT_EMAIL_TECHNICAL;
  if (alertEmail && env.EMAIL_JOBS) {
    try {
      await env.EMAIL_JOBS.send({
        to: alertEmail,
        subject,
        text: textBody,
        html: htmlBody,
        source: "inbound-exception-notice",
      });
      console.log(`[cron] inbound-exception-notice fired — candidates=${count} to=${alertEmail}`);
    } catch (error) {
      await logError(env.DB, {
        source: SOURCE,
        message: "[inbound-exception] email enqueue failed",
        error,
        context: { count, alertEmail },
      });
    }
  } else {
    await logError(env.DB, {
      level: "warn",
      source: SOURCE,
      message: `[inbound-exception] would notify (count=${count}) but ALERT_EMAIL_TECHNICAL/EMAIL_JOBS not configured`,
      context: { count, hasAlertEmail: !!alertEmail, hasQueue: !!env.EMAIL_JOBS },
    });
  }

  // Upsert debounce row regardless of dispatch outcome.
  try {
    await db
      .insert(inboundExceptionNoticeState)
      .values({
        id: NOTICE_KEY,
        lastNoticeDate: today,
        lastQueueCount: count,
        lastNotifiedAt: now,
      })
      .onConflictDoUpdate({
        target: inboundExceptionNoticeState.id,
        set: { lastNoticeDate: today, lastQueueCount: count, lastNotifiedAt: now },
      });
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "[inbound-exception] debounce upsert failed",
      error,
      context: { count },
    });
  }
}

// Exported for unit tests.
export const __test = {
  decideInboundExceptionNotice,
  utcDayKey,
  escapeHtml,
  NOTICE_KEY,
  SAMPLE_LIMIT,
  SALVAGE_INTENTS,
  NON_EVENT_INTENTS,
};
