/**
 * OPE-1226 — answering a person closes the obligation to answer them.
 *
 * `resolve_support_obligation` was the only closer, so every obligation stayed
 * `open` after John replied: on 2026-09-30, 37 of the 54 open rows already had
 * a `reply:manual` send on the same message or the same thread. The queue meant
 * to show who is still waiting mostly showed who had been answered.
 *
 * The match is deliberately NARROW — the message replied to, or its thread —
 * not "any reply to this address". `list_support_obligations` matches on the
 * recipient too, and that is exactly why it never auto-closed: a reply to the
 * same person can be about a different conversation. Those rows stay open, and
 * that listing still flags them `answered_not_closed`.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import { inboundEmails, supportObligations, SUPPORT_OBLIGATION_STATUS } from "./schema.js";
import type { Db } from "./db.js";

export const AUTO_CLOSED_BY = "auto:reply-manual";

/** The email-jobs `source` of a reply_to_inbound_email send. */
export const MANUAL_REPLY_SOURCE = "reply:manual";

/**
 * OPE-1510 — an approved draft that answers an inbound. A plain string, equal to
 * OPERATOR_OUTBOUND_SOURCE, because importing the tool module here would pull the
 * MCP tool layer into the queue consumer.
 */
export const OPERATOR_DRAFT_SOURCE = "operator:outbound";

/**
 * OPE-1252 — the close happens when the send is CONFIRMED, not when it is
 * queued. It used to run in reply_to_inbound_email right after the enqueue, so
 * both live auto-closes landed 7–8 s before their ledger row: a job that then
 * failed, was held by the reply gate, or was rejected by the provider would
 * have left the waiting person marked `answered`, gone from the open queue.
 * Called by the email-jobs consumer only after `env.EMAIL.send` accepted and
 * the `sent` ledger row was written; the note names that row.
 */
export function shouldCloseOnSend(job: {
  source?: string;
  inboundEmailId?: string | null;
}): boolean {
  return (
    !!job.inboundEmailId &&
    (job.source === MANUAL_REPLY_SOURCE || job.source === OPERATOR_DRAFT_SOURCE)
  );
}

export function closeNoteForSend(
  ledgerMessageId: string,
  providerMessageId?: string | null,
  source: string = MANUAL_REPLY_SOURCE
): string {
  const how =
    source === OPERATOR_DRAFT_SOURCE
      ? `an approved draft via review_operator_draft (${OPERATOR_DRAFT_SOURCE})`
      : `a manual reply via reply_to_inbound_email (${MANUAL_REPLY_SOURCE})`;
  return (
    `Answered by ${how}; ` +
    `email_send_ledger.message_id=${ledgerMessageId}` +
    (providerMessageId ? `, provider id ${providerMessageId}` : "") +
    "."
  );
}

/** Close every OPEN obligation on this inbound message or its thread. Returns the count. */
export async function closeObligationsAnsweredBy(
  db: Db,
  inboundEmailId: string,
  note: string
): Promise<number> {
  const [row] = await db
    .select({ threadId: inboundEmails.threadId })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, inboundEmailId))
    .limit(1);
  const threadId = row?.threadId ?? null;

  const onThisConversation = threadId
    ? or(
        eq(supportObligations.inboundEmailId, inboundEmailId),
        inArray(
          supportObligations.inboundEmailId,
          db
            .select({ id: inboundEmails.id })
            .from(inboundEmails)
            .where(eq(inboundEmails.threadId, threadId))
        )
      )
    : eq(supportObligations.inboundEmailId, inboundEmailId);

  const closed = await db
    .update(supportObligations)
    .set({
      status: SUPPORT_OBLIGATION_STATUS.ANSWERED,
      closedAt: new Date(),
      closedBy: AUTO_CLOSED_BY,
      closeNote: note,
    })
    .where(and(eq(supportObligations.status, SUPPORT_OBLIGATION_STATUS.OPEN), onThisConversation))
    .returning({ id: supportObligations.id });
  return closed.length;
}
