/**
 * OPE-412 — the receipt a submitter never got.
 *
 * The public form captures an email address, tells the reader their suggestion
 * will be reviewed, and then says nothing until (and unless) somebody approves
 * the event. Across the entire send ledger there has never been a
 * submission-received email: the only submission-lifecycle sources are
 * `submission-approved` (9 all-time) and `submission-salvaged` (7). One
 * submitter waited twelve days for their first and only message.
 *
 * The cost is not politeness. Without a receipt the submitter cannot tell a slow
 * review from a lost submission, so the rational move is to submit again — which
 * is how a quiet queue becomes a duplicated one.
 *
 * ── Why this ack makes NO turnaround promise ────────────────────────────────
 *
 * The ticket asked me to flag the choice rather than pick silently. Measured
 * against prod on 2026-08-17, for community/email submissions approved since
 * 2026-06-01:
 *
 *   approved submissions          6
 *   reviewed within 48 hours      0        ← zero, not "few"
 *   fastest                       19.0 days
 *   average                       33.6 days
 *   PENDING right now             9 (avg age 24.5 days, oldest 138)
 *
 * So the form's live promise — "our team reviews your suggestion within 24–48
 * hours", stated twice on /suggest-event — is currently met 0% of the time.
 * Repeating it in an email would take a claim the reader might not have noticed
 * on a page and deliver it to their inbox with our name on it, which is a
 * stronger promise made worse.
 *
 * This copy therefore says what is TRUE and useful — we have it, here is what
 * you sent, here is what happens next, here is how to reach us — and makes no
 * time claim at all. An ack with no deadline is not evasive; a deadline nothing
 * keeps is what damages trust. When the queue can hold a window, add it here in
 * one line.
 *
 * (The form's own 24–48h copy is a separate customer-facing change and is NOT
 * touched here — flagged to John on the issue instead.)
 */

import { and, eq, gte } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { emailSendLedger, emailSuppressionList } from "@/lib/db/schema";

type Db = DrizzleD1Database<typeof schema>;

export const SUBMISSION_RECEIVED_SOURCE = "email:submission-received";

/**
 * Most acks one address may receive per window. Someone entering three fairs in
 * one sitting is a GOOD submitter, and thanking them three times reads as a
 * malfunction — so the cap is per address, not per submission.
 */
export const MAX_ACKS_PER_WINDOW = 1;
export const ACK_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export type AckOutcome =
  | "sent"
  | "skipped:no-email"
  | "skipped:suppressed"
  | "skipped:rate-limited"
  | "skipped:disabled"
  | "error:queue-missing";

interface AckEnv {
  EMAIL_JOBS?: Queue<unknown>;
  /**
   * OPE-6 STOP-gate. The body below is new customer-facing copy and must have
   * John's nod before the first real send. Default off; while off the decision
   * is still recorded by the caller, so "we chose not to send" stays
   * distinguishable from "we tried and it failed".
   */
  SUBMISSION_ACK_ENABLED?: string;
}

export interface SubmissionAckInput {
  toEmail: string | null | undefined;
  eventName: string;
  eventId: string;
  /** Already-formatted, e.g. "August 22–24, 2026". Omitted when unknown rather
   *  than guessed — a receipt quoting a date we invented is worse than one that
   *  quotes none. */
  whenText?: string | null;
  /** Town/venue line, same rule. */
  whereText?: string | null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The copy. Kept as its own exported function so it can be reviewed and tested
 * without a queue, a DB, or a send.
 *
 * Reuses OPE-367's conclusions rather than re-litigating them: say what we did,
 * say what happens next, promise only what something keeps, and give a real way
 * to reach a person.
 */
export function buildSubmissionReceivedBody(input: SubmissionAckInput): {
  subject: string;
  text: string;
} {
  const details = [
    `What you sent us: ${input.eventName}`,
    input.whenText ? `When: ${input.whenText}` : null,
    input.whereText ? `Where: ${input.whereText}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const text = `Thanks for suggesting an event to Meet Me at the Fair!

We have it. Here is what came through:

${details}

What happens next: a person reviews every suggestion before it goes on the site, so this is not published yet. When it is, you will get one more email with the link. If we cannot make sense of something, we will write and ask rather than guess.

If you need to correct or add anything, just reply to this email — it reaches us, and quoting this message keeps it attached to your submission.

Reference: ${input.eventId.slice(0, 8)}

— Meet Me at the Fair`;

  return { subject: `We received your event suggestion: ${input.eventName}`, text };
}

/**
 * Send the acknowledgment, or explain in the return value why not.
 *
 * Never throws: a submission must succeed even if its receipt cannot be sent.
 * The submitter losing an email is a small harm; losing the event they typed in
 * is the thing this whole path exists to prevent.
 */
export async function sendSubmissionReceivedAck(
  db: Db,
  env: AckEnv,
  input: SubmissionAckInput
): Promise<AckOutcome> {
  const email = (input.toEmail ?? "").trim().toLowerCase();
  if (!email) return "skipped:no-email";

  if (env.SUBMISSION_ACK_ENABLED !== "true") return "skipped:disabled";

  try {
    // Suppression is checked BEFORE the rate limit: an unsubscribed or bounced
    // address must not be mailed at all, and the order matters if the two ever
    // disagree.
    const [suppressed] = await db
      .select({ email: emailSuppressionList.email })
      .from(emailSuppressionList)
      .where(eq(emailSuppressionList.email, email))
      .limit(1);
    if (suppressed) return "skipped:suppressed";

    // Rate limit reads the LEDGER rather than a counter of its own. The ledger
    // is what actually records sends, so it cannot drift from reality the way a
    // parallel tally would — and it costs no new state.
    const since = new Date(Date.now() - ACK_WINDOW_MS);
    const recent = await db
      .select({ messageId: emailSendLedger.messageId })
      .from(emailSendLedger)
      .where(
        and(
          eq(emailSendLedger.recipient, email),
          eq(emailSendLedger.source, SUBMISSION_RECEIVED_SOURCE),
          gte(emailSendLedger.sentAt, since)
        )
      )
      .limit(MAX_ACKS_PER_WINDOW + 1);
    if (recent.length >= MAX_ACKS_PER_WINDOW) return "skipped:rate-limited";

    if (!env.EMAIL_JOBS) return "error:queue-missing";

    const { subject, text } = buildSubmissionReceivedBody(input);
    await env.EMAIL_JOBS.send({
      to: email,
      subject,
      text,
      html: `<p>${escapeHtml(text).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`,
      source: SUBMISSION_RECEIVED_SOURCE,
    });
    return "sent";
  } catch {
    // Swallowed deliberately — see the docblock. The caller records the outcome.
    return "error:queue-missing";
  }
}
