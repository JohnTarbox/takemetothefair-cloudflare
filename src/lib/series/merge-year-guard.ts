/**
 * EH3 P3.2 — pure cross-year merge guard.
 *
 * Two events are different editions of a series (and must NOT be merged — link
 * them as occurrences instead) when both have a start date and their UTC years
 * differ. Same-year or unknown-year pairs fall through to today's merge behavior.
 * This is the guard against the original 548-link cross-year roster-fusion class.
 * The merge route calls this before executeMerge.
 */
export function differentEditionYears(
  aStart: Date | null | undefined,
  bStart: Date | null | undefined
): boolean {
  if (!aStart || !bStart) return false;
  return aStart.getUTCFullYear() !== bStart.getUTCFullYear();
}

/**
 * OPE-1327 — the edition-aware form. Two events are different editions when
 * their UTC years differ (above), OR when both carry an edition key and the keys
 * differ: May and October of one year on a multi-edition series are two
 * editions with two vendor rosters, and merging them fuses those rosters exactly
 * as a cross-year merge would. A NULL key (every annual-series row) never
 * triggers the key branch, so annual behaviour is unchanged.
 */
export function differentEditions(
  a: { startDate: Date | null | undefined; editionKey?: string | null },
  b: { startDate: Date | null | undefined; editionKey?: string | null }
): boolean {
  if (differentEditionYears(a.startDate, b.startDate)) return true;
  return !!a.editionKey && !!b.editionKey && a.editionKey !== b.editionKey;
}
