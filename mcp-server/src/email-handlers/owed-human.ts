/**
 * OPE-1018 — a customer's answer to a question a PERSON asked is owed a person.
 *
 * ── The specimens ─────────────────────────────────────────────────────────
 *
 * Every hand-written vendor-inquiry reply ends with an offer: "reply and say so
 * and I'll set up a free listing." On 2026-09-14 two people accepted.
 *
 *   57c3a91d  Peter Fish   "Yes - please add us to the directory"
 *             → classified claim_request → parked on the 7-day admin-decision
 *   626d2c1c  Becky Berry  answered our "which fair?" with the fair and a phone
 *             → classified support → status 'replied'
 *
 * Each got `thread-reply-ack` ("it has gone to the person you've been
 * corresponding with") within seconds, and nothing else happened. Nothing sent
 * it to anyone. Both rows read as handled; both were found ~11 hours later only
 * because John asked how they had been handled.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 * An inbound is OWED A HUMAN when:
 *   1. its headers name OUR message (`isReplyToOurThread` — the OPE-706 test,
 *      reused so the two can never disagree about what a reply-to-us is), AND
 *   2. the newest outbound we SENT on that thread BEFORE it arrived was a human
 *      send (`reply:manual*`).
 *
 * Clause 2 is "before it arrived", not "the latest on the thread". Measured on
 * both specimen threads, the row's own `thread-reply-ack` lands 4–7 s after
 * receipt and would otherwise be the latest send, making every specimen look
 * automated. And a reply to an AUTOMATED ack (thread badf050d position 2 —
 * answered 155 s after a `support-ack`) is correctly NOT owed: nobody asked it
 * anything.
 *
 * ── What it changes ───────────────────────────────────────────────────────
 *
 * The row ends `status='awaiting_human'` instead of 'replied'/'waiting', skips
 * the admin-decision pause (there is no decision to make — a person has to act),
 * and the operator gets one email promptly. That email is what makes the
 * approved `thread-reply-ack` copy true. The copy itself is unchanged.
 */
import { and, desc, eq, lt, ne } from "drizzle-orm";
import { emailSendLedger, inboundEmails } from "../schema.js";
import { isReplyToOurThread } from "../intent-fastpath.js";
import type { Db } from "../db.js";

/** The status an owed-a-human row ends in. Free text column; filterable. */
export const OWED_HUMAN_STATUS = "awaiting_human";

/** `email_send_ledger.source` of the operator notice — also the probe's evidence. */
export const OWED_HUMAN_NOTICE_SOURCE = "operator-owed-human-notice";

/** A send a person wrote: `reply:manual` (MCP tool) and `reply:manual-gmail`. */
export function isHumanSendSource(source: string | null | undefined): boolean {
  return typeof source === "string" && source.startsWith("reply:manual");
}

export interface OwedHumanVerdict {
  owed: boolean;
  threadId: string | null;
  /** Source of the newest send on the thread before this row arrived. */
  previousSendSource: string | null;
  /** ISO string, not Date: a step.do return is JSON-serialized on replay. */
  previousSendAt: string | null;
  fromAddress: string | null;
  subject: string | null;
  excerpt: string | null;
  receivedAt: string | null;
}

/** Pure half — exported for tests. */
export function decideOwedHuman(input: {
  inReplyTo: string | null;
  emailReferences: string | null;
  threadId: string | null;
  previousSendSource: string | null;
}): boolean {
  if (!input.threadId) return false;
  if (!isReplyToOurThread(input.inReplyTo, input.emailReferences)) return false;
  return isHumanSendSource(input.previousSendSource);
}

export async function resolveOwedHuman(db: Db, messageRowId: string): Promise<OwedHumanVerdict> {
  const [row] = await db
    .select({
      threadId: inboundEmails.threadId,
      inReplyTo: inboundEmails.inReplyTo,
      emailReferences: inboundEmails.emailReferences,
      receivedAt: inboundEmails.receivedAt,
      fromAddress: inboundEmails.fromAddress,
      subject: inboundEmails.subject,
      excerpt: inboundEmails.bodyTextExcerpt,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, messageRowId))
    .limit(1);

  const none: OwedHumanVerdict = {
    owed: false,
    threadId: row?.threadId ?? null,
    previousSendSource: null,
    previousSendAt: null,
    fromAddress: row?.fromAddress ?? null,
    subject: row?.subject ?? null,
    excerpt: row?.excerpt ?? null,
    receivedAt: row?.receivedAt ? row.receivedAt.toISOString() : null,
  };
  if (!row || !row.threadId || !row.receivedAt) return none;
  // Cheap header test first — most inbound is not a reply to us at all.
  if (!isReplyToOurThread(row.inReplyTo, row.emailReferences)) return none;

  const [prev] = await db
    .select({ source: emailSendLedger.source, sentAt: emailSendLedger.sentAt })
    .from(emailSendLedger)
    .innerJoin(inboundEmails, eq(inboundEmails.id, emailSendLedger.inboundEmailId))
    .where(
      and(
        eq(inboundEmails.threadId, row.threadId),
        ne(emailSendLedger.inboundEmailId, messageRowId),
        eq(emailSendLedger.status, "sent"),
        lt(emailSendLedger.sentAt, row.receivedAt)
      )
    )
    .orderBy(desc(emailSendLedger.sentAt))
    .limit(1);

  const previousSendSource = prev?.source ?? null;
  return {
    ...none,
    owed: decideOwedHuman({
      inReplyTo: row.inReplyTo,
      emailReferences: row.emailReferences,
      threadId: row.threadId,
      previousSendSource,
    }),
    previousSendSource,
    previousSendAt: prev?.sentAt ? prev.sentAt.toISOString() : null,
  };
}

function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string
  );
}

/** The operator notice. Internal mail to ALERT_EMAIL_TECHNICAL, never a customer. */
export function buildOwedHumanNotice(
  messageRowId: string,
  intent: string | null,
  v: OwedHumanVerdict
): { subject: string; text: string; html: string } {
  const who = v.fromAddress ?? "(no sender)";
  const subject = `[MMATF] ${who} answered your email — waiting on you`;
  const lines = [
    `${who} replied on a thread where the last thing we sent was written by a person` +
      ` (${v.previousSendSource ?? "?"} at ${v.previousSendAt ?? "?"}).`,
    `They got the automatic "it has gone to the person you've been corresponding with" ack. Nobody else has seen it.`,
    ``,
    `Subject: ${v.subject ?? "(no subject)"}`,
    `Received: ${v.receivedAt ?? "?"}`,
    `Classified as: ${intent ?? "(none)"} — status set to '${OWED_HUMAN_STATUS}', admin-decision pause skipped`,
    `Inbound id: ${messageRowId}`,
    `Thread: ${v.threadId ?? "?"}`,
    ``,
    `What they wrote (excerpt):`,
    v.excerpt ?? "(no text)",
    ``,
    `Answer with reply_to_inbound_email (inbound_email_id ${messageRowId}); that sets the row to 'replied'.`,
  ];
  const text = lines.join("\n");
  const html = `<pre style="white-space:pre-wrap;font-family:inherit">${esc(text)}</pre>`;
  return { subject, text, html };
}
