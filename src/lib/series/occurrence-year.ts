/**
 * OPE-1291 — the (series, year) → occurrence rule, shared by the page's
 * resolver (`resolveOccurrenceSlug`) and the middleware's ETag lookup, so the
 * validator is always computed for the SAME row the page renders. Two copies of
 * this rule would be a validator for one row on a page showing another.
 *
 * OPE-1324 — the rule itself now lives in `@takemetothefair/utils`
 * (edition-path.ts) so the MCP Worker uses the same one; these names stay for
 * the app's existing callers.
 */
import { parseOccurrenceSegment, pickOccurrenceForYear } from "@takemetothefair/utils";

/**
 * "2026" → 2026; anything that is not a canonical 4-digit year → null —
 * including an edition key ("2027-05"), which is not a year and must be
 * resolved with `resolveOccurrence`, never by reading a year out of it.
 */
export function parseOccurrenceYear(yearStr: string): number | null {
  const seg = parseOccurrenceSegment(yearStr);
  return seg?.kind === "year" ? seg.year : null;
}

export { pickOccurrenceForYear };
