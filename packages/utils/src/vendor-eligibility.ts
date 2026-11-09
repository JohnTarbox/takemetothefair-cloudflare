/**
 * OPE-1564 — who may be a VENDOR at an event, as its own axis.
 *
 * Not `commercial_vendors_allowed` (whether commercial sellers are admitted at
 * all) and not `primary_audience` (who may ATTEND). A juried guild shop can be
 * open to the public, admit commercial work, and still refuse every
 * non-member seller — the Craftworkers' Guild Holiday Shop, 2026-11-02, whose
 * rule survived only as description prose that nothing could filter or badge.
 *
 *   OPEN             — no restriction recorded. The default, and also what
 *                      "nobody has looked" reads as: it renders nothing, so an
 *                      event with no value set looks exactly as it did before.
 *   MEMBERS_ONLY     — sellers must belong to an organization (the org name
 *                      goes in `vendor_eligibility_org`).
 *   JURIED           — sellers are selected by a jury.
 *   INVITATION_ONLY  — sellers are invited; there is no open application.
 *
 * John's ruling (2026-11-02): such a show stays listed as a vendor
 * opportunity, with one plain statement. No how-to-join copy. The MEMBERS_ONLY
 * wording is John's exact sentence (decision 2026-11-08); the JURIED and
 * INVITATION_ONLY lines follow the same form and are not yet ruled on.
 */

export const VENDOR_ELIGIBILITY_VALUES = [
  "OPEN",
  "MEMBERS_ONLY",
  "JURIED",
  "INVITATION_ONLY",
] as const;
export type VendorEligibility = (typeof VENDOR_ELIGIBILITY_VALUES)[number];

/** The org name is public copy inside one sentence — keep it short. */
export const VENDOR_ELIGIBILITY_ORG_MAX = 120;

export function isVendorEligibility(v: unknown): v is VendorEligibility {
  return typeof v === "string" && (VENDOR_ELIGIBILITY_VALUES as readonly string[]).includes(v);
}

/**
 * The one public line for the event page's vendor section, or null when there
 * is nothing to say (OPEN, unknown, or an unrecognised stored value).
 *
 * `org` is used by MEMBERS_ONLY only; the other two states state a selection
 * method, not a membership, so naming an org there would read as a how-to-join
 * instruction the ruling excludes.
 */
export function vendorEligibilityLine(
  eligibility: string | null | undefined,
  org?: string | null
): string | null {
  if (!isVendorEligibility(eligibility)) return null;
  switch (eligibility) {
    case "OPEN":
      return null;
    case "MEMBERS_ONLY": {
      // A trailing period on the stored name would double up with ours.
      const name = (org ?? "").trim().replace(/\.+$/, "");
      return name
        ? `To be a vendor, you must be a member of ${name}.`
        : "To be a vendor, you must be a member of the organizing group.";
    }
    case "JURIED":
      return "To be a vendor, you must be accepted by the show's jury.";
    case "INVITATION_ONLY":
      return "To be a vendor, you must be invited by the organizer.";
  }
}
