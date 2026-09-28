/**
 * OPE-706 — an ack that asserts nobody has read the message must not fire on a
 * message that is a reply to something a person wrote.
 *
 * ── The specimen ──────────────────────────────────────────────────────────
 *
 * Tammy Gamache wrote to support@ on 2026-07-31 and heard nothing for a month.
 * John replied by hand on 08-30 asking *which fair*. She answered on 08-31 at
 * 15:47:34Z. **Eight seconds later** the workflow sent her `support-ack`:
 *
 *   "We've received your message and logged it. This is an automatic reply —
 *    it hasn't been read by a person yet."
 *
 * A person had read her, written to her, and asked her the question she was
 * answering. The sentence is false about that thread, and false in a way the
 * recipient can see.
 *
 * ── This is OPE-453's shape, one template over ────────────────────────────
 *
 * OPE-453: `no-url` emitted while `parsed_url` is non-null. Here: "nobody has
 * read this" emitted while `in_reply_to` names the person who did. Both are
 * "a reply template asserting a fact about the inbound, unchecked against the
 * field that would falsify it", and both are caught at the same choke point in
 * `workflows/inbound-email.ts` immediately before the send — the last moment
 * the pairing can still be stopped.
 *
 * ── Reword, do not suppress (ruled 2026-08-31) ────────────────────────────
 *
 * The ticket originally proposed suppression as "the safer default". Overruled
 * on the specimen's own evidence: Tammy's thread sat 30 days with an obligation
 * open and the ack was the ONLY thing that ever reached her. Suppression bets
 * on a human arriving promptly, and that bet loses. A clumsy ack is mildly
 * embarrassing and visible; wrong suppression means a customer hears nothing,
 * concludes we are dead, and fails silently.
 *
 * ── Why the eligible set is an explicit two, and narrow ────────────────────
 *
 * Only the generic acks that actually fired on the five measured rows, and
 * whose wording a prior human reply falsifies or makes odd. Widening this to
 * "every ack" would reword messages that are perfectly true on a reply thread
 * — the acceptance's own warning is that suppressing (or here, rewriting)
 * legitimate acks is the failure mode to avoid. Add a kind when a specimen
 * demands it, not in anticipation.
 */
import { inArray } from "drizzle-orm";
import { isReplyToOurThread } from "../intent-fastpath.js";
import { emailSendLedger } from "../schema.js";
import type { Db } from "../db.js";
import { storedMessageIdForms } from "./message-id-forms.js";
import { isHumanSendSource } from "./owed-human.js";
import type { ReplyKind } from "./types.js";

/**
 * Reply kinds whose copy is falsified — or made plainly odd — by the message
 * being a reply on a thread we are already in.
 *
 *  - `support-ack`     asserts "it hasn't been read by a person yet".
 *  - `correction-ack`  says the correction "will be reviewed shortly" and that
 *                      "we'll reply directly if we have questions" — to someone
 *                      who is mid-answer to a question we already asked.
 *
 * Three of the five measured rows were `correction-ack` and one `support-ack`;
 * the fifth was a `forwarded` parent that sends nothing.
 */
export const THREAD_REPLY_OVERRIDABLE_KINDS: readonly ReplyKind[] = [
  "support-ack",
  "correction-ack",
  // OPE-1134 — the new acks make the same "not read by a person" claim.
  "vendor-inquiry-ack",
  "claim-request-ack",
];

/**
 * True when this reply should become `thread-reply-ack` instead.
 *
 * The header test is `isReplyToOurThread`, which already existed for the
 * trusted-sender fast-path and is REUSED rather than reimplemented. It is also
 * stricter than the SQL the ticket measured with: `/@(?:[a-z0-9-]+\.)?
 * meetmeatthefair\.com>/i` requires the closing angle bracket and tolerates a
 * subdomain, where `LIKE '%@meetmeatthefair.com%'` would miss
 * `@mail.meetmeatthefair.com` and match an unterminated fragment.
 *
 * ⚠️ The kind check comes FIRST and is the load-bearing half. Of the 19 rows
 * carrying any `in_reply_to`, 14 are forwards of third-party newsletters whose
 * header names the NEWSLETTER's thread. A predicate keyed on "has an
 * in_reply_to" rather than "names OUR message-id" would silently reword all 14.
 */
export function shouldUseThreadReplyAck(
  replyKind: ReplyKind | null | undefined,
  inReplyTo: string | null | undefined,
  emailReferences: string | null | undefined,
  repliedTo?: RepliedToSend
): boolean {
  if (!replyKind) return false;
  if (!THREAD_REPLY_OVERRIDABLE_KINDS.includes(replyKind)) return false;
  if (!isReplyToOurThread(inReplyTo ?? null, emailReferences ?? null)) return false;
  // OPE-1214 — when the caller knows what the reply answers, only a HUMAN send
  // makes the copy true. Undefined keeps the header-only behaviour for callers
  // that have not looked (pure tests of the header rule).
  return repliedTo === undefined || repliedTo === "human";
}

/**
 * OPE-1214 — what the message being replied to WAS.
 *
 * `thread-reply-ack` says the reply is "attached to your existing thread" and
 * has "gone to the person you've been corresponding with". The header test
 * alone (`isReplyToOurThread`) only proves the parent is one of OUR messages —
 * and most of our messages are automated. An organizer answering the
 * content-links-sync "your event was featured" notice (2026-09-28, Christmas
 * Prelude) got both claims although no person had ever written to him.
 *
 *  - `human`     — a matched send whose source is `reply:manual*`.
 *  - `automated` — matched sends exist, none written by a person.
 *  - `unknown`   — our domain in the header but no ledger row to say.
 *
 * Only `human` earns the thread-reply wording. The ledger is read directly by
 * provider_message_id — NOT joined to inbound_emails, as the thread resolver
 * does, because a broadcast or notice has no inbound row and would vanish.
 */
export type RepliedToSend = "human" | "automated" | "unknown";

export async function classifyRepliedToSend(
  db: Db,
  inReplyTo: string | null | undefined,
  emailReferences: string | null | undefined
): Promise<RepliedToSend> {
  const forms = storedMessageIdForms(inReplyTo, emailReferences);
  if (forms.length === 0) return "unknown";
  const sends = await db
    .select({ source: emailSendLedger.source })
    .from(emailSendLedger)
    .where(inArray(emailSendLedger.providerMessageId, forms))
    .limit(forms.length);
  if (sends.length === 0) return "unknown";
  return sends.some((s) => isHumanSendSource(s.source)) ? "human" : "automated";
}
