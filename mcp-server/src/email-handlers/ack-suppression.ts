/**
 * OPE-1609 — a withheld reply has to be recorded as withheld.
 *
 * Inbound 7f761f2a (2026-11-10) was classifier-timed-out, so the OPE-1148
 * zero-confidence guard withheld its ack. `mark-done` then wrote the handler's
 * result anyway: `status='replied'`, `reply_kind='support-ack'`, and nothing in
 * `email_send_ledger`. An organizer asking to list her events read as answered
 * on every surface.
 *
 * Two separate gaps, so two separate pieces here:
 *
 *  1. The ledger. OPE-1163 established that a suppression is ledgered `stubbed`
 *     with its reason, so it can be audited next to the sends it replaced. Only
 *     that one guard and the held-send path did so. `ledgerSuppressedReply`
 *     gives the other suppressions the same row.
 *  2. The row itself, for the case where the person really got nothing.
 *     `suppressedAckOutcome` rewrites what mark-done stores.
 *
 * Deliberately NOT rewritten: burst followers and fan-out losers. OPE-407 and
 * OPE-720 keep their `replied`/`reply_kind` on purpose, because another message
 * in the burst or family spoke for them. They get the ledger row only.
 */
import { eq } from "drizzle-orm";
import type { getDb } from "../db.js";
import { ledgerEmailSend, wasEmailSent } from "../mailer.js";
import { logError } from "../logger.js";
import { inboundEmails } from "../schema.js";
import { OWED_HUMAN_STATUS } from "./owed-human.js";
import type { FinalStatus } from "./types.js";

type Db = ReturnType<typeof getDb>;

export const ZERO_CONFIDENCE_UNCLEAR_REASON = "classifier-unclear-zero-confidence";

/** Prefix of the crossing ref a handler returns when it opened an obligation. */
const OBLIGATION_REF_PREFIX = "support_obligation:";

/**
 * What mark-done stores for an ack the zero-confidence guard withheld.
 *
 * `reply_kind` names the ack that did NOT go, so no reader can take it for a
 * send. `status` stops saying `replied`: `awaiting_human` when the handler
 * opened an obligation, because that person is owed an answer, and otherwise
 * `forwarded`, the value noop.ts already uses for "nothing was sent".
 */
export function suppressedAckOutcome(input: {
  replyKind: string;
  status: FinalStatus;
  crossingDestinationRef?: string | null;
  reason: string;
}): { replyKind: string; status: FinalStatus } {
  const replyKind = `${input.replyKind}-suppressed:${input.reason}`;
  if (input.status !== "replied") return { replyKind, status: input.status };
  const owesHuman = input.crossingDestinationRef?.startsWith(OBLIGATION_REF_PREFIX) ?? false;
  return { replyKind, status: owesHuman ? (OWED_HUMAN_STATUS as FinalStatus) : "forwarded" };
}

/**
 * Ledger a withheld reply as `stubbed`, naming why.
 *
 * Skips when `reply-<id>` is already `sent`: this upserts on that key, so a
 * re-run after a real send would otherwise erase the record of the send.
 * Failsoft like the ledger itself; an audit row must not fail the workflow
 * before mark-done records the outcome.
 */
export async function ledgerSuppressedReply(
  db: Db,
  input: { messageRowId: string; replyKind: string; reason: string }
): Promise<void> {
  const messageId = `reply-${input.messageRowId}`;
  try {
    if (await wasEmailSent(db, messageId)) return;
    const [row] = await db
      .select({ fromAddress: inboundEmails.fromAddress, subject: inboundEmails.subject })
      .from(inboundEmails)
      .where(eq(inboundEmails.id, input.messageRowId))
      .limit(1);
    await ledgerEmailSend(db, {
      messageId,
      recipient: row?.fromAddress ?? null,
      source: `reply:${input.replyKind}`,
      subject: row?.subject ?? null,
      status: "stubbed",
      provider: "stub",
      error: `suppressed: ${input.reason}`,
      inboundEmailId: input.messageRowId,
    });
  } catch (error) {
    await logError(db, {
      source: "mcp:email-handler:ack-suppression",
      message: "could not ledger a suppressed reply",
      error,
      context: { messageRowId: input.messageRowId, reason: input.reason },
    });
  }
}
