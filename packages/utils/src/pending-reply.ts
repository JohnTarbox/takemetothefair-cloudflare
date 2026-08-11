/**
 * OPE-368 (R4) — what happens when the EMAIL_REPLY_ENABLED gate refuses.
 *
 * There are TWO refusal sites — the MCP tool (`reply_to_inbound_email`) and the
 * admin route (`POST /api/admin/inbound-emails/:id/reply`) — in two different
 * Workers. Both previously returned a message and dropped the draft on the
 * floor.
 *
 * The behaviour lives here, in one function both call, because two
 * implementations of "what a refusal means" is how they drift — the defect
 * OPE-372 was about, and the reason OPE-280 and OPE-295 exist. A refusal that
 * preserves the draft in one path and discards it in the other would be worse
 * than either, since nobody could tell which happened.
 *
 * Deliberately NOT a decision about whether to send. It records that a send was
 * wanted and refused. Whether the gate opens is John's call alone.
 */

export interface RefusedReplyDraft {
  inboundEmailId: string;
  toAddress: string;
  subject: string | null;
  bodyText: string;
  /** Agent code or admin user id. */
  requestedBy: string | null;
}

export interface RefusedReplyRecord extends RefusedReplyDraft {
  id: string;
  requestedAt: Date;
  status: "pending";
}

/**
 * Build the row for a refused reply.
 *
 * Pure so both Workers can persist it with their own db handle, and so the
 * shape is testable without a database. `id` is injected rather than generated
 * here for the same reason.
 */
export function buildRefusedReply(
  draft: RefusedReplyDraft,
  now: Date,
  id: string
): RefusedReplyRecord {
  return {
    ...draft,
    // Trimmed, but never truncated: the whole point is that an operator can
    // read exactly what would have gone out.
    bodyText: draft.bodyText.trim(),
    id,
    requestedAt: now,
    status: "pending",
  };
}

/**
 * The message a refused caller gets back.
 *
 * It names the draft id, because the previous message told the caller only that
 * it was disabled — which is why, on 2026-08-10, an agent reported to John that
 * a reply "was blocked" and neither of them could say what had become of it.
 * A refusal that cannot be followed up on is indistinguishable from a failure.
 */
export function refusedReplyMessage(draftId: string): string {
  return (
    "Reply sending is disabled (EMAIL_REPLY_ENABLED != 'true'). Nothing was sent — " +
    `but your draft is SAVED as pending reply ${draftId} and is waiting for operator ` +
    "review. It has not been lost. An admin can approve or discard it; approved drafts " +
    "go out when the flag is enabled."
  );
}
