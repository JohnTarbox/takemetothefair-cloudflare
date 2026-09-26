/**
 * OPE-1163 — `thread-reply-ack` must not fire into a live human conversation.
 *
 * ── The specimens (prod, 2026-09-25) ─────────────────────────────────────
 *
 * 22 `reply:thread-reply-ack` sends all-time; 15 went out within 24h of a
 * `reply:manual` to the same person. Two were answers to a thank-you:
 *
 *   ashleighmo@  manual 15:04:20 → "Thank you for the information and for
 *                getting back to me so quickly. I appreciate the help."
 *                → robot ack 8 s later, row parked `awaiting_human`.
 *   bbaldino@    manual 00:34:26 → "Thank you for your informative response.
 *                I have loved your website, so glad I found it."
 *                → robot ack 5 s later, row parked `awaiting_human`.
 *
 * The ack exists for a reply that might otherwise feel lost. When a person here
 * answered hours ago, or the sender is only saying thanks, it lands as a robot
 * interrupting a personal exchange.
 *
 * ── Two rules, both SUPPRESS-ONLY ─────────────────────────────────────────
 *
 *  1. `recent-human-reply` — no thread ack when a `reply:manual*` send went to
 *     this thread OR this recipient within N hours before the message arrived.
 *     N lives in `tunable_thresholds` (THREAD_ACK_QUIET_HOURS_KEY) so it can be
 *     tuned without a deploy. The operator notice (OPE-1018) still goes, so the
 *     person is still owed — and gets — a human.
 *  2. `closed-by-sender` — no ack, and no "waiting on you" status, when the
 *     sender's own new text is only thanks / a sign-off.
 *
 * ── Why rule 2 is a small explicit test and abstains hard ─────────────────
 *
 * A missed ack is harmless; a real question filed as "closed" is not. So the
 * test says CLOSING only when every one of these holds on the sender's own text
 * (quote, greeting and signature stripped): it thanks us; beyond the thanks it
 * has at most ONE short sentence; no question mark, no link, no digit (dates,
 * phones, prices are new information) and no word that asks for or corrects
 * something. Anything else → not closing → today's behaviour. Checked against
 * the 22 real thread-reply-ack inbounds: "Yes - please add us" and "I was
 * talking about the Rhode Island one" both stay NOT closing. Wording of the ack is untouched (no OPE-6 copy change).
 */
import { and, desc, eq, gte, like, lte, or, sql } from "drizzle-orm";
import { emailSendLedger, inboundEmails, tunableThresholds } from "../schema.js";
import type { Db } from "../db.js";
import { senderAuthoredText } from "./sender-authored-text.js";
import { shouldUseThreadReplyAck } from "./thread-reply-ack.js";
import { ledgerEmailSend } from "../mailer.js";
import type { ReplyKind } from "./types.js";

export const THREAD_ACK_QUIET_HOURS_KEY = "thread_ack_quiet_after_human_hours";
/** The ticket's suggested start; used only when the tunable row is missing. */
export const DEFAULT_THREAD_ACK_QUIET_HOURS = 72;

/** `inbound_emails.status` for a thank-you that ends the thread. */
export const CLOSED_BY_SENDER_STATUS = "closed_by_sender";

export type ThreadAckSuppressReason = "recent-human-reply" | "closed-by-sender";

/** Longest sender text (chars, before the sign-off) still read as closing. */
const CLOSING_MAX_CHARS = 400;
/** A non-thanks sentence longer than this is content, not a pleasantry. */
const PLEASANTRY_MAX_WORDS = 15;

const GRATITUDE = /\b(thank(s| you| u)?|thx|appreciate[ds]?|much obliged|grateful)\b/i;

/**
 * Words that ask for something, correct something, or bring news. Any one in
 * the kept text → abstain. Deliberately broad: over-matching only means the ack
 * still sends, which is today's behaviour.
 */
const NOT_CLOSING =
  /\b(please|pls|could|can|would|will|when|where|how|why|wondering|but|however|also|question|need|want|add|remove|delete|change|update|correct(ion)?|wrong|instead|actually|meant|mistake|sorry|attach(ed|ment)?|send|booth|vendor|apply|application|register|price|fee|cost|date|time|cancel|unsubscribe|help me|let me know)\b/i;

const GREETING = /^(hi|hello|hey|dear|good (morning|afternoon|evening))\b[^.!?]{0,40}[,!.]?$/i;

/** A line that ends the message: everything after it is signature. */
const SIGN_OFF =
  /^(best|best regards|kind regards|warm regards|regards|sincerely|cheers|warmly|take care|all the best|thanks|thank you|many thanks|thanks again|thank you again)[,!.]*$/i;

/**
 * The sender's own sentences: quote and `-- ` signature stripped, `>`-quoted
 * lines dropped (Apple Mail's "> On … wrote:" escapes `stripQuotedReply`),
 * greetings dropped, and cut at a sign-off line so a signature's phone number
 * or title is not read as content.
 */
function ownSegments(bodyText: string | null | undefined): { kept: string[]; raw: string } {
  const own = senderAuthoredText(bodyText)
    .split("\n")
    .filter((l) => !/^\s*>/.test(l))
    .join("\n")
    .trim();
  const kept: string[] = [];
  // Paragraphs, with soft-wrapped lines re-joined ("…so quickly. I\nappreciate
  // the help." is one sentence run, not a stray "I").
  outer: for (const para of own.split(/\n\s*\n/)) {
    const lines = para
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const body: string[] = [];
    for (const [i, line] of lines.entries()) {
      // Sign-off FIRST: "Best," is also shaped like a bare-name salutation.
      if (SIGN_OFF.test(line)) {
        if (body.length) kept.push(...sentences(body.join(" ")));
        // "Thanks!" as a sign-off still counts as thanks; "Best," does not.
        if (GRATITUDE.test(line)) kept.push(line);
        break outer; // everything after a sign-off is signature
      }
      // A salutation: "Hi John," or a bare "John,".
      if (i === 0 && (GREETING.test(line) || /^[A-Z][\w'-]*,$/.test(line))) continue;
      body.push(line);
    }
    // A short unpunctuated paragraph is a name / title line ("Bruce").
    const joined = body.join(" ");
    if (!joined) continue;
    if (!/[.!?,;:]/.test(joined) && joined.split(/\s+/).length <= 3) continue;
    kept.push(...sentences(joined));
  }
  return { kept, raw: own };
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter((x) => x && !/^[.!?,;\s]+$/.test(x));
}

/**
 * True only when the sender's own text is thanks plus at most one short
 * pleasantry, and nothing else. Pure — exported for tests.
 */
export function isConversationClosing(bodyText: string | null | undefined): boolean {
  const { kept, raw } = ownSegments(bodyText);
  if (kept.length === 0) return false;
  // Links anywhere in the sender's text (signature included) → abstain.
  if (/https?:\/\/|www\./i.test(raw)) return false;
  const text = kept.join(" ");
  if (text.length > CLOSING_MAX_CHARS) return false;
  if (/[?]/.test(text) || /\d/.test(text)) return false;
  if (NOT_CLOSING.test(text)) return false;
  const thanks = kept.filter((s) => GRATITUDE.test(s));
  const other = kept.filter((s) => !GRATITUDE.test(s));
  if (thanks.length === 0) return false;
  if (other.length > 1) return false;
  return other.every((s) => s.split(/\s+/).length <= PLEASANTRY_MAX_WORDS);
}

/** Read N from `tunable_thresholds`; a missing or non-positive row → default. */
export async function readThreadAckQuietHours(db: Db): Promise<number> {
  const [row] = await db
    .select({ value: tunableThresholds.value })
    .from(tunableThresholds)
    .where(eq(tunableThresholds.key, THREAD_ACK_QUIET_HOURS_KEY))
    .limit(1);
  const v = row?.value;
  return typeof v === "number" && v > 0 ? v : DEFAULT_THREAD_ACK_QUIET_HOURS;
}

export interface RecentHumanReply {
  source: string;
  /** ISO — a step.do return is JSON-serialised on replay. */
  sentAt: string;
}

/**
 * The newest person-written send (`reply:manual*`, status sent) to this thread
 * or this recipient within `hours` before `receivedAt`. Thread OR recipient:
 * a manual reply composed outside the thread (a fresh Gmail message) still
 * counts as a live conversation with that person.
 */
export async function findRecentHumanReply(
  db: Db,
  input: { threadId: string | null; recipient: string | null; receivedAt: Date; hours: number }
): Promise<RecentHumanReply | null> {
  const since = new Date(input.receivedAt.getTime() - input.hours * 3_600_000);
  const who = (input.recipient ?? "").trim().toLowerCase();
  const scope = [
    input.threadId ? eq(inboundEmails.threadId, input.threadId) : undefined,
    who ? sql`LOWER(${emailSendLedger.recipient}) = ${who}` : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);
  if (scope.length === 0) return null;

  const [row] = await db
    .select({ source: emailSendLedger.source, sentAt: emailSendLedger.sentAt })
    .from(emailSendLedger)
    .leftJoin(inboundEmails, eq(inboundEmails.id, emailSendLedger.inboundEmailId))
    .where(
      and(
        like(emailSendLedger.source, "reply:manual%"),
        eq(emailSendLedger.status, "sent"),
        gte(emailSendLedger.sentAt, since),
        lte(emailSendLedger.sentAt, input.receivedAt),
        or(...scope)
      )
    )
    .orderBy(desc(emailSendLedger.sentAt))
    .limit(1);
  if (!row?.source || !row.sentAt) return null;
  return { source: row.source, sentAt: row.sentAt.toISOString() };
}

export interface ThreadAckGuardResult {
  reason: ThreadAckSuppressReason | null;
  /** The kind that WOULD have been sent (post thread-reply-ack swap). */
  kind: ReplyKind;
  detail: string | null;
}

/**
 * The workflow's `reply-guard/thread-ack` step body. Decides whether the ack
 * for this inbound is withheld and, if so, ledgers it as 'stubbed' with the
 * reason — so each suppression sits in `email_send_ledger` next to the sends
 * it replaced. Only the thread ack is subject to `recent-human-reply`; any ack
 * is withheld for `closed-by-sender`.
 */
export async function decideThreadAckGuard(
  db: Db,
  input: { messageRowId: string; replyKind: ReplyKind; closedBySender: boolean }
): Promise<ThreadAckGuardResult> {
  const [r] = await db
    .select({
      fromAddress: inboundEmails.fromAddress,
      receivedAt: inboundEmails.receivedAt,
      threadId: inboundEmails.threadId,
      inReplyTo: inboundEmails.inReplyTo,
      emailReferences: inboundEmails.emailReferences,
      subject: inboundEmails.subject,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, input.messageRowId))
    .limit(1);
  if (!r) return { reason: null, kind: input.replyKind, detail: null };

  const becomesThreadAck =
    input.replyKind === "thread-reply-ack" ||
    shouldUseThreadReplyAck(input.replyKind, r.inReplyTo, r.emailReferences);
  const kind: ReplyKind = becomesThreadAck ? "thread-reply-ack" : input.replyKind;

  let reason: ThreadAckSuppressReason | null = null;
  let detail: string | null = null;
  if (input.closedBySender) {
    reason = "closed-by-sender";
  } else if (becomesThreadAck && r.receivedAt) {
    const hours = await readThreadAckQuietHours(db);
    const recent = await findRecentHumanReply(db, {
      threadId: r.threadId,
      recipient: r.fromAddress,
      receivedAt: r.receivedAt,
      hours,
    });
    if (recent) {
      reason = "recent-human-reply";
      detail = `${recent.source} at ${recent.sentAt}, within ${hours}h`;
    }
  }
  if (reason) {
    await ledgerEmailSend(db, {
      messageId: `reply-${input.messageRowId}`,
      recipient: r.fromAddress,
      source: `reply:${kind}`,
      subject: r.subject ?? null,
      status: "stubbed",
      provider: "stub",
      error: `suppressed: ${reason}${detail ? ` (${detail})` : ""}`,
      inboundEmailId: input.messageRowId,
    });
  }
  return { reason, kind, detail };
}
