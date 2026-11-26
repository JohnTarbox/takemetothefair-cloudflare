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

import { and, eq, gte, lt, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { emailSendLedger, emailSuppressionList, events } from "@/lib/db/schema";
import { sanitizeEmailSubject } from "@takemetothefair/utils";

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
  /**
   * OPE-1558 decision 1a (John, 2026-11-02) — mint a private correction link
   * for this submission and return its full URL, or null if none could be
   * minted. Called ONLY once every skip gate has passed, immediately before
   * the enqueue, so a receipt that never sends never leaves a live 30-day
   * token behind. Passed by the /list-your-event path only; omitted, the body
   * is the 2026-08-27 copy unchanged.
   */
  mintCorrectionUrl?: () => Promise<string | null>;
}

/**
 * OPE-1558 decision 1a — the paragraph APPROVED BY JOHN on 2026-11-02, verbatim
 * (comment f44c06f8 on OPE-1558, approving the text quoted in the AGENT BLOCKED
 * ask). Inserted after the "just reply to this email" paragraph.
 *
 * "30 days" here is the LINK'S validity (TOKEN_TTL_DAYS in correction-tokens),
 * not a review turnaround — the no-turnaround-promise rule above is about how
 * fast a person reviews, and this paragraph makes no claim about that.
 */
export function correctionLinkParagraph(url: string): string {
  return `Need to change something later? This private link lets you update your listing — no account needed. It works for 30 days:
${url}`;
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
 * The copy — APPROVED BY JOHN on the issue, 2026-08-27, and reproduced verbatim.
 *
 * His note: *"If the template's real merge-field names differ from the {{...}}
 * placeholders above, map to the actual fields — the wording is what's
 * approved, not the placeholder syntax."* So the mapping is:
 *
 *   {{event_name}}           -> input.eventName
 *   {{submitted_dates}}      -> input.whenText   (omitted when unknown)
 *   {{submitted_location}}   -> input.whereText  (omitted when unknown)
 *   {{submission_ref}}       -> first 8 of input.eventId
 *   {{first_name_or_there}}  -> "there", ALWAYS — see below
 *
 * ⚠️ There is no submitter name anywhere to map. `/suggest-event` captures an
 * email address and nothing else; `events.suggester_email` has no `_name`
 * sibling. So the greeting is always "Hi there," rather than sometimes
 * personal — which is the honest reading of `first_name_or_there` given the
 * data, not a shortcut. If a name field is ever captured, this is the one line
 * to change.
 *
 * ⚠️ NO TIME WORDS, and that is load-bearing rather than stylistic. The form
 * promised review "within 24–48 hours" and the queue met it **0 times out of
 * 6** — fastest 19.0 days, average 33.6. Putting that promise in an email would
 * take a line the reader might have skimmed on a page and deliver it to their
 * inbox over our name: a stronger promise, made worse. A test asserts the body
 * contains no time words; keep it that way.
 *
 * Kept as its own exported function so the copy can be reviewed and tested
 * without a queue, a DB, or a send.
 */
export function buildSubmissionReceivedBody(
  input: SubmissionAckInput,
  /** OPE-1558 — when present, the approved correction-link paragraph is added. */
  correctionUrl?: string | null
): {
  subject: string;
  text: string;
} {
  // Unknown fields are OMITTED rather than printed blank. A receipt with an
  // empty line where the date should be reads as broken, and a receipt quoting
  // a date we invented is worse than one that quotes none.
  const details = [input.eventName, input.whenText || null, input.whereText || null]
    .filter(Boolean)
    .join("\n");

  const text = `Hi there,

Thanks for submitting an event to Meet Me at the Fair. This note confirms we've got it — here's what came through:

${details}

Your event isn't published yet — every submission is reviewed by a person before it goes live on the site. We'll take it from here.

If anything above looks wrong, or you'd like to add details (a website, times, vendor info, a photo), just reply to this email and it'll reach us.
${correctionUrl ? `\n${correctionLinkParagraph(correctionUrl)}\n` : ""}
Reference: ${input.eventId.slice(0, 8)} — please keep this on any reply so we can match it up.

Thanks for helping us keep Maine and New England's fairs and festivals listed.

— The Meet Me at the Fair team`;

  // OPE-1392 (TPL-2) — the event name is submitter-supplied.
  return { subject: sanitizeEmailSubject(`We received your event — ${input.eventName}`), text };
}

/**
 * OPE-412 — is there an event from this address, created inside the window,
 * that sorts BEFORE this one? Reads committed rows, so it is race-free where
 * the ledger is not. Exported for tests.
 */
export async function hasEarlierSubmissionInWindow(
  db: Db,
  email: string,
  eventId: string,
  since: Date
): Promise<boolean> {
  const [self] = await db
    .select({ createdAt: events.createdAt })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (!self?.createdAt) return false;
  const [earlier] = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        sql`lower(${events.suggesterEmail}) = ${email}`,
        gte(events.createdAt, since),
        or(
          lt(events.createdAt, self.createdAt),
          and(eq(events.createdAt, self.createdAt), lt(events.id, eventId))
        )
      )
    )
    .limit(1);
  return earlier !== undefined;
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

    // OPE-412 (rework 2026-10-04) — the ledger alone cannot see a BURST. The
    // ack is only enqueued here; its ledger row is written by the queue
    // consumer seconds later, so N submissions inside that gap all read zero
    // and all send (09-21: three acks to one address in 5s). The submissions'
    // own EVENT rows are committed before this runs, so they can: only the
    // earliest submission from this address in the window acks. Ties on the
    // second-resolution timestamp break on id, so exactly one wins.
    if (await hasEarlierSubmissionInWindow(db, email, input.eventId, since)) {
      return "skipped:rate-limited";
    }

    if (!env.EMAIL_JOBS) return "error:queue-missing";

    // OPE-1558 — mint the correction link only now, past every skip gate. A
    // failed mint sends the receipt WITHOUT the paragraph rather than not at
    // all: the receipt is the thing OPE-412 exists to deliver.
    let correctionUrl: string | null = null;
    if (input.mintCorrectionUrl) {
      try {
        correctionUrl = await input.mintCorrectionUrl();
      } catch {
        correctionUrl = null;
      }
    }

    const { subject, text } = buildSubmissionReceivedBody(input, correctionUrl);
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
