/**
 * OPE-979 — a promoter that is no longer trading.
 *
 * CEASED (the business closed) and MERGED (it became part of another) both mean
 * the page describes a company a reader cannot deal with any more: it gets a
 * "No longer operating" notice and no "claim this page" prompt — nobody should be
 * invited to claim a closed business. NULL / UNKNOWN / ACTIVE render as before.
 */
export function isClosedPromoter(status: string | null | undefined): boolean {
  return status === "CEASED" || status === "MERGED";
}
