/**
 * OPE-954 — the one rule every inbound send path asks before emailing anyone
 * about a row: is this row's mail suppressed, and if so, why?
 *
 * A row-level flag (`inbound_emails.replies_suppressed_reason`), not a run
 * parameter, because a workflow run is not the only sender. The stale-inbound
 * sweep re-dispatches a stuck row as a NORMAL run, and its give-up path emails
 * the submitter itself. A replay has to be silent across all of them, or the
 * submitter gets the automated message the replay was approved never to send.
 *
 * Returns the ledger `error` text for a held send, or null when sending is
 * allowed. Row suppression wins over the global flag, so the ledger names the
 * real reason the mail was held.
 */
export function heldSendReason(
  row: { repliesSuppressedReason?: string | null } | null | undefined,
  autoReplyEnabled: boolean,
  globalHeldReason: string
): string | null {
  const own = row?.repliesSuppressedReason?.trim();
  if (own) return `suppressed: ${own}`;
  if (!autoReplyEnabled) return globalHeldReason;
  return null;
}
