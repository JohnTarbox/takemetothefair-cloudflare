/**
 * OPE-421 — reject a fairground name written into `venues.city`.
 *
 * ---------------------------------------------------------------------------
 * Why this guard is deliberately narrow
 * ---------------------------------------------------------------------------
 *
 * The tempting version flags anything that looks unlike a town: values
 * containing Center, Park, Hall, Museum, a trailing state code. Measured
 * against production, that rule returned 9 of 968 active venues and **six were
 * correct data**:
 *
 *   Winchester Center, CT    a real village (already in the CT region list)
 *   Cumberland Center, ME    a real village
 *   Manchester Center, VT    a real village (x2)
 *   Hallowell, ME            matched only because it contains "hall"
 *   Winhall, VT              matched only because it contains "hall"
 *
 * A 67% false-positive rate, on a rule that reads perfectly sensibly. Shipped
 * as a write-boundary block it would have rejected legitimate venues in
 * Winchester Center and Manchester Center forever, and shipped as a bulk fix it
 * would have repeated OPE-219's four wrong pins.
 *
 * So this checks ONE thing: does the value name a fairground rather than a
 * place? New England has towns called Center Harbor and Hyde Park; it has no
 * municipality whose name contains "fairground" or the word "grounds". That
 * makes this token separable in a way "center" and "hall" are not.
 *
 * Against the current corpus: 3 true positives, 0 false positives.
 *
 * A guard that is right about a narrow thing beats one that is usually right
 * about a broad thing, because the broad one's mistakes land on correct data
 * and are invisible until someone audits.
 */

/**
 * Tokens that never appear in a New England municipality name but do appear in
 * the fairground names that leaked into this column.
 *
 * `grounds` is matched as a whole word so "Groundswell" or a hypothetical
 * "Groundsville" is not caught; `fairground` is matched as a substring because
 * both singular and plural occur.
 */
const FAIRGROUND_PATTERNS: readonly RegExp[] = [/fairground/i, /\bgrounds\b/i];

export interface VenueCityCheck {
  /** True when the value looks like a venue/fairground rather than a town. */
  implausible: boolean;
  /** Human-readable reason, or null when the value is fine. */
  reason: string | null;
}

/**
 * There is deliberately NO `suggestion` field.
 *
 * The first version returned a best-guess town parsed out of the bad value, and
 * its own tests caught it emitting "West Springfield Big-E" for
 * "West Springfield Big-E Grounds" and "The" for "The Fairgrounds" — confident,
 * wrong, and exactly the shape a caller would write unattended.
 *
 * Recovering the town needs knowledge this function does not have (that "Big-E"
 * is a venue qualifier and "West Springfield" is the town). The repair belongs
 * with a human or a real gazetteer (OPE-425), corroborated against the row's
 * coordinates. This guard's job is to REFUSE the bad value, and a proposal
 * field is an invitation to the automated fix OPE-219 warns about.
 */

/**
 * Is this `venues.city` value a fairground name rather than a town?
 *
 * Returns a verdict rather than throwing so callers can choose: a strict write
 * path can reject, an importer can flag for review. Never mutates.
 */
export function checkVenueCityPlausibility(city: string | null | undefined): VenueCityCheck {
  const clean = (city ?? "").trim();
  if (clean === "") return { implausible: false, reason: null };

  const hit = FAIRGROUND_PATTERNS.find((p) => p.test(clean));
  if (!hit) return { implausible: false, reason: null };

  return {
    implausible: true,
    reason:
      `"${clean}" names a fairground, not a municipality — venues.city must hold the TOWN. ` +
      `A venue name here silently drops the venue out of every city-keyed match ` +
      `(region facets, the state-page town count, findDuplicate's city_state_date stage).`,
  };
}
