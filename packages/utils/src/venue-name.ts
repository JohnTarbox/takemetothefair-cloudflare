/**
 * Venue-name ingest helper (DQ2 — backlog row, 2026-06-04).
 *
 * Prevents the U9 root cause: rows where the venue `name` field is a bare
 * street address (e.g. "18 Spring Street", "256 High Street", "100 Riverside
 * Drive"). Display-side fallback already lives at
 * src/lib/venue-display.ts (`displayVenueName`), but read-time correction
 * doesn't prevent ingest of bad data — and breaks slug stability whenever an
 * operator later renames the row.
 *
 * This helper runs at WRITE time on every venue-create path:
 *   - packages/validation/src/index.ts venueCreateSchema (via .transform)
 *   - mcp-server/src/tools/admin.ts create_venue tool (manual call)
 *   - mcp-server/src/tools/vendor.ts suggest_event venue auto-create
 *     (manual call — the AI-extraction path most likely to ship address-
 *     as-name from form scraping)
 *
 * Coercion strategy: when `name` looks like a street address OR equals
 * `address`, derive a fallback name ("Event venue in {City}, {State}") and
 * copy the offending string into `address` if not already present. This
 * mirrors `displayVenueName`'s fallback so the stored value matches what
 * the public would have seen anyway.
 *
 * Conservative match: a name that BEGINS with a digit run followed by
 * whitespace AND contains a street-type word ("St", "Road", "Route" …). A
 * leading number alone used to be enough, which renamed real venues such as
 * "450 Banquets" (OPE-1688). False negatives are fine — name-equals-address
 * still catches them; false positives rewrite a correct name, so stay narrow.
 */

const STREET_NUMBER_RE = /^\s*\d+\s+\S/;

/**
 * OPE-1688 — street-type words. A leading number alone is NOT address
 * evidence: "450 Banquets" (Chicopee MA) was renamed "Event venue in
 * Chicopee, MA" at ingest on 2026-11-18, and "5 Star Hall" / "3 Rivers
 * Fairgrounds" are the same shape. An address also names a street TYPE.
 * Matched as a whole token (trailing "." / "," ignored), case-insensitive.
 */
const STREET_TYPE_TOKENS = new Set([
  "street",
  "st",
  "road",
  "rd",
  "avenue",
  "ave",
  "av",
  "drive",
  "dr",
  "lane",
  "ln",
  "boulevard",
  "blvd",
  "highway",
  "hwy",
  "route",
  "rte",
  "rt",
  "pike",
  "turnpike",
  "tpke",
  "way",
  "court",
  "ct",
  "place",
  "pl",
  "parkway",
  "pkwy",
  "circle",
  "cir",
  "terrace",
  "ter",
  "trail",
  "trl",
  "square",
  "sq",
  "extension",
  "ext",
]);

export interface VenueNameInput {
  name: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
}

export interface VenueNameCoercion {
  name: string;
  address: string;
  wasCoerced: boolean;
  reason?: "street-number-in-name" | "name-equals-address";
}

/**
 * True iff `name` reads as a street address: it BEGINS with a house-number
 * run followed by whitespace (the original U9 shape) AND some later token is
 * a street-type word. The single shared implementation — the display
 * fallback (`src/lib/venue-display.ts`) and the `venues_named_by_address`
 * recommendation rule both call this, so ingest, render and the admin queue
 * agree on what counts as an address (OPE-1688).
 */
export function looksLikeVenueStreetAddress(name: string | null | undefined): boolean {
  if (!name) return false;
  if (!STREET_NUMBER_RE.test(name)) return false;
  const tokens = name.trim().split(/\s+/).slice(1);
  return tokens.some((t) => STREET_TYPE_TOKENS.has(t.replace(/[.,;:]+$/, "").toLowerCase()));
}

/**
 * Returns the venue-location fallback string for a venue without a real
 * name, used as the corrected name at ingest. Mirrors the read-time
 * `locationFallback` in src/lib/venue-display.ts so stored and displayed
 * strings line up.
 */
export function venueLocationFallback(venue: Pick<VenueNameInput, "city" | "state">): string {
  const city = (venue.city ?? "").trim();
  const state = (venue.state ?? "").trim();
  if (city && state) return `Event venue in ${city}, ${state}`;
  if (city) return `Event venue in ${city}`;
  if (state) return `Event venue in ${state}`;
  return "Event venue";
}

/**
 * Detect address-as-name at ingest and coerce. Returns the original
 * `{name, address}` unchanged when no problem detected.
 *
 * When coerced:
 *   - `name` becomes the location fallback (city/state derived)
 *   - `address` gets the offending string IF address was previously empty;
 *     otherwise address is preserved as-is (we don't overwrite real data)
 *   - `wasCoerced: true` and `reason` is set for caller-side logging
 */
export function coerceVenueNameAtIngest(input: VenueNameInput): VenueNameCoercion {
  const rawName = (input.name ?? "").trim();
  const rawAddress = (input.address ?? "").trim();

  const nameEqualsAddress = rawAddress.length > 0 && rawName === rawAddress;
  const nameLooksLikeStreet = looksLikeVenueStreetAddress(rawName);

  if (!nameEqualsAddress && !nameLooksLikeStreet) {
    return { name: rawName, address: rawAddress, wasCoerced: false };
  }

  const derivedName = venueLocationFallback(input);
  // Only fill address from name if address was empty; never overwrite
  // a real address with the suspicious name.
  const derivedAddress = rawAddress.length > 0 ? rawAddress : rawName;

  return {
    name: derivedName,
    address: derivedAddress,
    wasCoerced: true,
    reason: nameEqualsAddress ? "name-equals-address" : "street-number-in-name",
  };
}
