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
import { and, eq, or, not, isNull, isNotNull, inArray, desc, asc, sql } from "drizzle-orm";
import { inboundEmails, inboundExceptionNoticeState } from "@takemetothefair/db-schema";
import type { Env } from "./index.js";
import { getDb } from "./db.js";
import { logError } from "./logger.js";
import { NON_ACTIONABLE_EXACT_SENDERS } from "./email-handlers/audit-sender.js";
import {
  TERMINAL_UNHANDLED_REPLY_KINDS,
  DISPOSED_INBOUND_STATUSES,
} from "@takemetothefair/constants";

const SOURCE = "mcp:schedule:inbound-exception-notice";

/** Constant PK for the single debounce row. */
const NOTICE_KEY = "inbound_exception_notice";

/** How many sample rows to include in the notice body. */
const SAMPLE_LIMIT = 5;

/** Routed-intent values that represent a real event-submission attempt — the
 *  only rows a human should salvage. (`new_event` is the classifier value;
 *  `submit` is the routed pipeline value — both appear on inbound_emails.intent.)
 *
 *  OPE-532 added `photo_intake`. Someone emailing a photo of a fair is making a
 *  real submission attempt, so a `status='failed'` photo intake with no event
 *  is exactly the thing this queue exists to surface — and prod held one
 *  (2026-08-10) that no count has ever included. */
const SALVAGE_INTENTS = ["new_event", "submit", "photo_intake"] as const;

/** Classified intents that are unambiguously NOT event submissions and safe to
 *  auto-dispose to the reversible 'rejected' state. Deliberately excludes
 *  'unclear' (ambiguous — could be a misclassified real event). */
const NON_EVENT_INTENTS = ["spam", "unsubscribe"] as const;

/**
 * OPE-532 — reply kinds that END the pipeline without producing an event and
 * without leaving anyone owing a reply. The submission is simply lost.
 *
 * These are invisible to the original predicate for a reason worth stating: the
 * ack is what sets the status. When the photo lane cannot resolve a fair it
 * sends the "which fair?" auto-reply and writes `status='replied'`, which is
 * the same status a fully successful submission gets. So the row records its
 * own failure as a success, and two shipped detectors (OPE-17 here, OPE-247's
 * frozen-queue RED) watched ten of them go by on 2026-08-23 without a word.
 *
 * Included:
 *   photo-intake-unresolved  the photo arrived, the fair did not resolve.
 *                            9 live rows, oldest 2026-07-17.
 *   no-url-prose-failed      no URL to retry AND prose extraction failed. We
 *                            had the content and got nothing out of it.
 *                            6 live rows, oldest 2026-06-01.
 *
 * Deliberately EXCLUDED — `no-url` (13 live rows). There the sender was asked
 * for a URL and has not yet answered, so the ball is in their court, not ours.
 * It is a different queue ("awaiting submitter") and folding it in here would
 * put rows nobody can act on into a list whose subject line says a human needs
 * to salvage them. Enumerated on the ticket for an explicit ruling rather than
 * silently absorbed.
 */
// Values live in @takemetothefair/constants so the main app's queue-drain row
// and this notice cannot drift apart. See the doc comment there.
export { TERMINAL_UNHANDLED_REPLY_KINDS };
const DISPOSED_STATUSES = DISPOSED_INBOUND_STATUSES;

/** The TRUE salvage-candidate predicate — the human-triage queue. Exported so
 *  the count query, the sample query, and an optional `list_inbound_exceptions`
 *  MCP tool all share one source of truth. */
export const salvageCandidateWhere = and(
  // Hoisted out of both branches: whatever route a row took, having produced an
  // event is what "handled" means. This is also the clause that keeps OPE-532
  // scope 4 honest — 5 of the 10 rows from the 2026-08-23 batch have since been
  // resolved and still carry `reply_kind='photo-intake-unresolved'`, so keying
  // the queue on the reply kind alone would have counted them for ever.
  isNull(inboundEmails.resultingEventId),
  or(
    // (A) OPE-17's original queue — extraction failed outright.
    and(eq(inboundEmails.status, "failed"), inArray(inboundEmails.intent, [...SALVAGE_INTENTS])),
    // (B) OPE-532 — terminated in an acknowledgement rather than an action.
    //     Status-agnostic by design: the whole defect is that the status says
    //     'replied'. Only an explicit disposal takes a row back out.
    and(
      inArray(inboundEmails.replyKind, [...TERMINAL_UNHANDLED_REPLY_KINDS]),
      not(inArray(inboundEmails.status, [...DISPOSED_STATUSES]))
    )
  ),
  // OPE-74 belt-and-suspenders — never surface never-actionable audit/system
  // sender loopbacks (e.g. notify@meetmeatthefair.com) in the human-triage
  // count, even if one ever reached status='failed' with a submission intent.
  // New arrivals are terminal-stated to 'audit-noop' at ingest
  // (email-handler.ts → isNonActionableSender), so this is a defensive backstop
  // that shares its source-of-truth address list. Empty list → always-true, no-op.
  NON_ACTIONABLE_EXACT_SENDERS.length > 0
    ? sql`lower(${inboundEmails.fromAddress}) NOT IN (${sql.join(
        NON_ACTIONABLE_EXACT_SENDERS.map((addr) => sql`${addr}`),
        sql`, `
      )})`
    : undefined
);

/** Format a Date as `YYYY-MM-DD` in UTC — matches the once-per-day comparison. */
function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * OPE-532 scope 2 — age thresholds, in days, at which a queue that is not
 * moving is worth saying again.
 *
 * Mirrors OPE-413's manner for the PENDING queue: a backlog is reported by age
 * and not only by size, because "N items" is the number people learn to ignore.
 * Coarse and widening on purpose — an item crossing 3 days is news, and after
 * that the reminders should get rarer, not daily.
 */
export const AGE_ESCALATION_DAYS = [3, 7, 14, 30, 60, 90] as const;

/** The highest escalation threshold this age has crossed; 0 if none. */
export function ageBucket(ageDays: number): number {
  let bucket = 0;
  for (const d of AGE_ESCALATION_DAYS) if (ageDays >= d) bucket = d;
  return bucket;
}

/**
 * Pure decision gate — exported for unit tests. Identical shape to OPE-15's
 * decideRosterNotice: fire only when the queue is non-empty, not already
 * notified today, and changed since the last notice.
 *
 * OPE-532 adds the second reason to speak. The count-only rule had a hole that
 * matters more than it looks: `lastQueueCount === count` suppresses the notice,
 * so a queue that STOPS DRAINING goes quiet exactly when it has become a
 * problem. A backlog frozen at 9 for a month was, by this gate, indistinguishable
 * from one nobody needed to hear about. Now a flat queue speaks again when its
 * oldest item crosses an escalation threshold.
 *
 * `lastOldestAgeBucket` is null for rows predating drizzle/0227 and is read as
 * "never escalated", so the first ageing queue after deploy reports once rather
 * than being suppressed by a fabricated zero.
 *
 * The two later parameters are optional so the OPE-17 callers and their tests
 * keep their meaning unchanged: with no age information this is exactly the
 * original gate.
 */
export function decideInboundExceptionNotice(
  count: number,
  lastNoticeDate: string | null,
  lastQueueCount: number | null,
  today: string,
  oldestAgeBucket: number = 0,
  lastOldestAgeBucket: number | null = null
): boolean {
  if (count <= 0) return false;
  // At most one notice a day, whatever else changed. This outranks escalation:
  // a queue crossing a threshold is not worth a second email the same morning.
  if (lastNoticeDate === today) return false;
  if (lastQueueCount !== null && lastQueueCount === count) {
    // Count unchanged — speak only if the backlog has aged into a new bucket.
    const escalated = lastOldestAgeBucket !== null && oldestAgeBucket > lastOldestAgeBucket;
    if (!escalated) return false;
  }
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

  // OPE-532 scope 2 — how old is the oldest thing in there? A queue is
  // reported by age as well as size, so a backlog that stops draining cannot
  // hide behind an unchanged count.
  let oldestAgeDays = 0;
  try {
    const oldestRows = await db
      .select({ receivedAt: inboundEmails.receivedAt })
      .from(inboundEmails)
      .where(salvageCandidateWhere)
      .orderBy(asc(inboundEmails.receivedAt))
      .limit(1);
    const oldest = oldestRows[0]?.receivedAt;
    if (oldest) {
      oldestAgeDays = Math.floor((now.getTime() - new Date(oldest).getTime()) / 86_400_000);
    }
  } catch (error) {
    // Cosmetic-failsoft, like every other DB op in this module: losing the age
    // must not cost the notice. Bucket 0 simply means "no escalation reason",
    // so the count rule still applies.
    await logError(env.DB, {
      level: "warn",
      source: SOURCE,
      message: "[inbound-exception] oldest-age query failed; notifying on count alone",
      error,
    });
  }
  const oldestBucket = ageBucket(oldestAgeDays);

  // Read debounce state.
  let lastNoticeDate: string | null = null;
  let lastQueueCount: number | null = null;
  let lastOldestAgeBucket: number | null = null;
  try {
    const stateRow = await db.query.inboundExceptionNoticeState.findFirst({
      where: eq(inboundExceptionNoticeState.id, NOTICE_KEY),
    });
    if (stateRow) {
      lastNoticeDate = stateRow.lastNoticeDate;
      lastQueueCount = stateRow.lastQueueCount;
      lastOldestAgeBucket = stateRow.lastOldestAgeBucket ?? null;
    }
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "[inbound-exception] debounce read failed",
      error,
    });
    return;
  }

  if (
    !decideInboundExceptionNotice(
      count,
      lastNoticeDate,
      lastQueueCount,
      today,
      oldestBucket,
      lastOldestAgeBucket
    )
  ) {
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
  // The age goes in the SUBJECT, not just the body. A subject that reads the
  // same every morning is the one that stops being opened, which is the
  // failure OPE-413 named for the PENDING queue.
  const ageSuffix = oldestAgeDays > 0 ? ` (oldest ${oldestAgeDays}d)` : "";
  const subject = `📥 Inbound-email triage: ${count} ${noun} need a human to salvage${ageSuffix}`;
  const sampleLines = samples.map(
    (s) => ` • ${s.subject?.trim() || "(no subject)"} — ${s.fromAddress}`
  );
  const sampleBlock = sampleLines.length ? `Sample:\n${sampleLines.join("\n")}\n\n` : "";
  const textBody =
    `${count} inbound ${noun} are in the human-triage exception queue — no event created, and ` +
    `either a failed extraction or a reply that closed the thread without acting. They need a ` +
    `human to salvage. Oldest has been waiting ${oldestAgeDays} day(s).\n\n` +
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
    `need a human to salvage — no event created, and either a failed extraction or a reply that ` +
    `closed the thread without acting. Oldest has been waiting <strong>${oldestAgeDays}</strong> day(s).</p>` +
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
        lastOldestAgeBucket: oldestBucket,
      })
      .onConflictDoUpdate({
        target: inboundExceptionNoticeState.id,
        set: {
          lastNoticeDate: today,
          lastQueueCount: count,
          lastNotifiedAt: now,
          // Must be in the UPDATE set too, not only in `values`. The row is
          // created once and updated on every run thereafter, so a bucket
          // written only on insert would stay frozen at its first value and
          // the escalation would silently never fire again.
          lastOldestAgeBucket: oldestBucket,
        },
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
  // OPE-532. A re-export shim that misses a new symbol is a silent hole —
  // the test importing it gets `undefined` and its assertions read as green.
  ageBucket,
  AGE_ESCALATION_DAYS,
  TERMINAL_UNHANDLED_REPLY_KINDS,
  DISPOSED_STATUSES,
};
