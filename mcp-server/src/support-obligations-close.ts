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
import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import { extractEmailAddress } from "@takemetothefair/utils";
import {
  inboundEmails,
  supportObligations,
  SUPPORT_OBLIGATION_KIND,
  SUPPORT_OBLIGATION_STATUS,
} from "./schema.js";
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
 * OPE-1627 — `create_claim_invite`'s primary send. It answers an inbound only
 * when called with `in_reply_to_inbound_email_id`, which is the only time it
 * carries an `inboundEmailId`; a cold invite has none and closes nothing.
 */
export const CLAIM_INVITE_SOURCE = "email:claim-invite";

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
    (job.source === MANUAL_REPLY_SOURCE ||
      job.source === OPERATOR_DRAFT_SOURCE ||
      job.source === CLAIM_INVITE_SOURCE)
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
      : source === CLAIM_INVITE_SOURCE
        ? `a threaded claim invite via create_claim_invite (${CLAIM_INVITE_SOURCE})`
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

// ── OPE-1683: an operator draft composed by hand answers its recipient ──────

export const AUTO_CLOSED_BY_DRAFT = "auto:operator-draft";

/**
 * A draft John composed himself (`compose_operator_email`) carries no
 * `inboundEmailId`, so `shouldCloseOnSend` never fires for it. Both live
 * specimens (Harvard Square 11-15, OHTM 11-18) were answered that way and had
 * to be closed by hand as `not_needed`.
 */
export function shouldCloseByAddressOnSend(job: {
  source?: string;
  inboundEmailId?: string | null;
  operatorDraftId?: string | null;
}): boolean {
  return job.source === OPERATOR_DRAFT_SOURCE && !job.inboundEmailId && !!job.operatorDraftId;
}

/** Bare, lower-cased addresses from a `to` header that may list several. */
export function recipientAddresses(to: string | null | undefined): string[] {
  return [
    ...new Set(
      (to ?? "")
        .split(",")
        .map((part) => extractEmailAddress(part.trim()).trim().toLowerCase())
        .filter((a) => a.includes("@"))
    ),
  ];
}

/**
 * Close every OPEN **contact** obligation from one of these addresses that was
 * opened at or before the send. Matched on the address, not the subject:
 * contacts reply under changed subjects (ticket note).
 *
 * Narrower than "any obligation for this address" on purpose: OPE-1226 kept
 * SUPPORT obligations off address matching because a reply to the same person
 * can be about a different conversation. A contact obligation is owed to the
 * person (OPE-1510: one reply per contact), so an approved draft to them is the
 * answer. Support obligations still close only on their own message or thread.
 */
export async function closeContactObligationsByAddress(
  db: Db,
  addresses: string[],
  sentAt: Date,
  note: string
): Promise<number> {
  if (addresses.length === 0) return 0;
  const fromLower = sql<string>`lower(${supportObligations.fromAddress})`;
  const addressMatch = or(
    inArray(fromLower, addresses),
    ...addresses.map((a) => sql`${fromLower} like ${"%<" + a + ">"}`)
  );
  const closed = await db
    .update(supportObligations)
    .set({
      status: SUPPORT_OBLIGATION_STATUS.ANSWERED,
      closedAt: sentAt,
      closedBy: AUTO_CLOSED_BY_DRAFT,
      closeNote: note,
    })
    .where(
      and(
        eq(supportObligations.status, SUPPORT_OBLIGATION_STATUS.OPEN),
        eq(supportObligations.kind, SUPPORT_OBLIGATION_KIND.CONTACT),
        lte(supportObligations.openedAt, sentAt),
        addressMatch
      )
    )
    .returning({ id: supportObligations.id });
  return closed.length;
}

export function closeNoteForDraftSend(
  draftId: string,
  ledgerMessageId: string,
  providerMessageId?: string | null
): string {
  return (
    `Answered by approved operator draft ${draftId} via review_operator_draft ` +
    `(${OPERATOR_DRAFT_SOURCE}), matched on the recipient address; ` +
    `email_send_ledger.message_id=${ledgerMessageId}` +
    (providerMessageId ? `, provider id ${providerMessageId}` : "") +
    "."
  );
}
