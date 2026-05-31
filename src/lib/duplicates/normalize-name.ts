/**
 * Normalize an event name for similarity-based duplicate matching.
 *
 * Used by /api/suggest-event/check-duplicate as the tiebreaker when the
 * place+date match key (K2 parts 1+2) can't disambiguate. Same strategy
 * is intended to back the unified `findDuplicate(placeKey, dateRange,
 * normalizedName)` helper in K2 part 4 (deferred to a follow-up PR), so
 * this lives in the shared duplicates module instead of the route file
 * — Next.js doesn't allow non-handler named exports from route files.
 *
 * Strip rules, in order:
 *   1. Lower-case
 *   2. Leading ordinal: "38th " / "1st " / "2nd " / "3rd "
 *   3. Leading "Annual " (case-insensitive after step 1)
 *   4. Trailing 4-digit year: " 2026"
 *   5. Non-alphanumeric (kept whitespace)
 *   6. Collapse whitespace + trim
 *
 * Locked in by the Winthrop Arts Festival case (analyst K2, 2026-05-31):
 * "38th Annual Winthrop Arts Festival" and "Winthrop Arts Festival 2026"
 * must both reduce to "winthrop arts festival" so they pass the 0.85
 * Levenshtein-similarity threshold instead of creating PENDING
 * duplicate 25ef60f0 alongside APPROVED 4ee1de4a.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^\s*\d+(st|nd|rd|th)\s+/, "")
    .replace(/^\s*annual\s+/i, "")
    .replace(/\s+\d{4}\s*$/, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
