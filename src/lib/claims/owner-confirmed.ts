/**
 * OPE-238 — when may a listing show an ownership badge?
 *
 * A claim used to become fully public the instant somebody registered: the
 * badge rendered off `vendors.claimed` alone, with no verification condition,
 * while `emailVerified` was still false. `src/app/api/auth/register/route.ts`
 * says so in its own comment — *"Always false here — verification lands
 * minutes-to-hours later"*. Measured 2026-08-30: 73 listings claimed, **26 of
 * the claimants have never confirmed an email address**.
 *
 * ── The label, ruled by John 2026-08-31 ──────────────────────────────────
 *
 *   claimed, email unverified            → NO badge (pending)
 *   claimed, email verified              → "Owner-confirmed"
 *   paid Enhanced Profile                → "Enhanced"      (unchanged)
 *   verified_pro                         → "Verified Pro"  (unchanged)
 *
 * "Verified" is NOT reused. It already means the paid Enhanced Profile tier
 * (`isEnhanced && vendor.verified`), and overloading it would muddle a trust
 * signal a shopper is being asked to rely on. The public string "Claimed"
 * retires: with ownership now labelled "Owner-confirmed", nothing is left for
 * it to say. `vendors.claimed` stays as the data field — it simply stops being
 * a rendered label.
 *
 * ── Why this is a function and not an inline `&&` ────────────────────────
 *
 * Three surfaces render this badge (detail page, vendor card, featured strip)
 * and they are fed by different queries. An inline conjunction at each site is
 * three chances to get it wrong, and the failure is silent in the worst
 * direction: a missed condition shows a trust badge that was not earned.
 *
 * ⚠️ `ownerEmailVerified` is deliberately OPTIONAL and falsy-by-default. A
 * caller whose query has not been updated to fetch it renders NO badge rather
 * than the old unconditional one. That is the fail-closed direction on purpose:
 * the cost of a missed wiring is a badge that does not appear, not a badge that
 * lies.
 */

export interface OwnerConfirmedInput {
  /** `vendors.claimed` — somebody asserted ownership. */
  claimed?: boolean | null;
  /**
   * `users.email_verified IS NOT NULL` for the row's owner.
   *
   * Optional so an un-updated caller fails closed. Pass `null`/`undefined` only
   * when you genuinely do not know — never as a shortcut for "probably fine".
   */
  ownerEmailVerified?: boolean | null;
}

/**
 * True when the listing may show the "Owner-confirmed" badge.
 *
 * Both halves are required. `ownerEmailVerified` alone is not enough: a user
 * can confirm their email without ever claiming anything, and a verified
 * account attached to a listing nobody claimed is not an ownership statement.
 */
export function isOwnerConfirmed(input: OwnerConfirmedInput): boolean {
  return Boolean(input.claimed) && Boolean(input.ownerEmailVerified);
}
