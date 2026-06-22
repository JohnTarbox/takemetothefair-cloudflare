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
