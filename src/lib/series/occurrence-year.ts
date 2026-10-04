/**
 * OPE-1291 — the (series, year) → occurrence rule, shared by the page's
 * resolver (`resolveOccurrenceSlug`) and the middleware's ETag lookup, so the
 * validator is always computed for the SAME row the page renders. Two copies of
 * this rule would be a validator for one row on a page showing another.
 */

/** "2026" → 2026; anything that is not exactly a canonical integer → null. */
export function parseOccurrenceYear(yearStr: string): number | null {
  const year = Number.parseInt(yearStr, 10);
  return Number.isInteger(year) && String(year) === yearStr ? year : null;
}

/** The occurrence whose start date falls in `year` (UTC), as the page picks it. */
export function pickOccurrenceForYear<T extends { startDate: Date | null }>(
  occurrences: readonly T[],
  year: number
): T | undefined {
  return occurrences.find((o) => o.startDate && new Date(o.startDate).getUTCFullYear() === year);
}
