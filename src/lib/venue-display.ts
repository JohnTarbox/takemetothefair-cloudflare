/**
 * Venue display-name helper. Avoid showing raw street addresses as
 * venue names in the public UI when the underlying row has a misnamed
 * `name` (e.g. created via a URL-import path that picked up the
 * address from the form field as the name).
 *
 * Cohort 8 (analyst, 2026-06-01) — C9/U9 from the dev-email bundle.
 * Example bad rows: "18 Spring Street", "256 High Street", "100
 * Riverside Drive" appearing as venue NAMES on the venues directory.
 * The cleanup happens in two parts:
 *   1. This display fallback (read-time) — never shows the raw street
 *      number as the name; renders "{type} location at {city}, {state}"
 *      instead. Zero-risk: doesn't mutate stored data, doesn't change
 *      slugs or URLs.
 *   2. The rule in src/lib/recommendations/rules/venues-named-by-
 *      address.ts surfaces affected rows on the admin queue so the
 *      operator can rename via the existing venue edit form.
 *
 * The street-number detection is intentionally conservative: it only
 * matches names that BEGIN with a digit run followed by whitespace
 * (which catches "18 Spring Street" but not "Building 5" or "10X
 * Studios"). False negatives are fine — the operator queue will catch
 * them. False positives are bad — they'd suppress legitimate names.
 */

const STREET_NUMBER_RE = /^\s*\d+\s+\S/;

export interface VenueLike {
  name: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
}

/**
 * True iff `name` looks like a raw street address (begins with a
 * digit run followed by whitespace and at least one more character).
 * Exported for the recommendation rule + tests.
 */
export function looksLikeStreetAddress(name: string): boolean {
  if (!name) return false;
  return STREET_NUMBER_RE.test(name);
}

/**
 * Return the display string for a venue's name. When the stored name
 * is a street address, fall back to "{City}, {State} venue" or similar.
 * Returns the stored name when it looks normal.
 */
export function displayVenueName(venue: VenueLike): string {
  const raw = (venue.name ?? "").trim();
  if (!raw) {
    // No name at all — same fallback path.
    return locationFallback(venue);
  }
  // Also catch the case where the name and address are bit-identical
  // (set via a form that copied the address into the name field).
  if (venue.address && raw === venue.address.trim()) {
    return locationFallback(venue);
  }
  if (looksLikeStreetAddress(raw)) {
    return locationFallback(venue);
  }
  return raw;
}

function locationFallback(venue: VenueLike): string {
  const city = venue.city?.trim();
  const state = venue.state?.trim();
  if (city && state) return `Event venue in ${city}, ${state}`;
  if (city) return `Event venue in ${city}`;
  if (state) return `Event venue in ${state}`;
  return "Event venue";
}
