/**
 * OPE-1398 — the ONE rule for whether a vendor's STREET address may be shown
 * publicly.
 *
 * John's ruling (2026-10-16): a vendor that signed itself up is very often one
 * person working from home, so its street address is hidden by default on
 * every public surface (detail page, JSON-LD, lists, public APIs, non-admin
 * export). City, state and ZIP stay public; the phone number stays public.
 * Admin views keep the full address. A self-signup vendor can opt back in
 * from its own profile (`show_street_address`, default off).
 *
 * "Self-signup" is the persisted `vendors.self_signup` flag (drizzle/0376):
 * set by the registration route (`/api/auth/register`) when it mints the
 * vendor row, and backfilled for rows whose owner is a `users.origin =
 * 'registration'` account created in the same moment as the vendor. Admin-,
 * MCP- and import-created vendors — including ones a person later CLAIMED —
 * are not self-signup, and keep their address public.
 *
 * Every public render path calls `withPublicStreetAddress` (or
 * `publicStreetAddress`) at its loader, so the street string never reaches a
 * template, a JSON-LD block, or a client component's RSC payload.
 */

export interface VendorStreetAddressFields {
  address?: string | null;
  selfSignup?: boolean | number | null;
  showStreetAddress?: boolean | number | null;
}

/** True when this vendor's street address must not be shown publicly. */
export function isStreetAddressHidden(v: VendorStreetAddressFields): boolean {
  return Boolean(v.selfSignup) && !v.showStreetAddress;
}

/** The street address a public surface may show: the stored one, or null. */
export function publicStreetAddress(v: VendorStreetAddressFields): string | null {
  if (isStreetAddressHidden(v)) return null;
  return v.address ?? null;
}

/**
 * Returns the row with `address` nulled when it is hidden, plus
 * `hasStreetAddress` — whether a street address is ON FILE. The SEO
 * indexability predicate counts a stored address as geo (mirroring the
 * sitemap's SQL gate), so callers feed it `hasStreetAddress` instead of the
 * (possibly nulled) string; hiding an address must not flip a page to noindex.
 */
export function withPublicStreetAddress<T extends VendorStreetAddressFields>(
  v: T
): T & { address: string | null; hasStreetAddress: boolean } {
  const hasStreetAddress = !!v.address && v.address.trim().length > 0;
  return { ...v, address: publicStreetAddress(v), hasStreetAddress };
}
