/**
 * OPE-42 — boundary-safe meta-description truncation.
 *
 * Pure, dependency-light helpers shared by the four detail-page metadata
 * builders (events / vendors / venues / promoters). Kept in its own module so
 * `src/lib/seo-utils.ts` and any page can import it without pulling the whole
 * SEO surface.
 */

/**
 * Trim trailing function words (conjunctions, articles, prepositions) from a
 * word-truncated string. A word-boundary cut sometimes leaves a hanging
 * "and" / "for" / "the" / "of" that reads awkwardly before an appended
 * ellipsis. Strip them along with any trailing comma. Trailing sentence
 * punctuation (a completed sentence) is preserved.
 *
 * Exported for direct testing and re-exported from `seo-utils` for back-compat.
 */
export function trimTrailingFunctionWord(text: string): string {
  // Match (1+ trim cycles): optional comma, whitespace, function word, end.
  // Repeated to handle e.g. "...crafts, and " → "...crafts" (strip "and" then ",").
  const FUNCTION_WORDS =
    /[\s,;:—-]+(?:and|or|but|nor|for|the|a|an|of|to|in|on|at|by|with|from|into|onto|upon)$/i;
  let prev = text.trimEnd();
  let next = prev.replace(FUNCTION_WORDS, "");
  while (next !== prev) {
    prev = next.trimEnd().replace(/[,;:]+$/, "");
    next = prev.replace(FUNCTION_WORDS, "");
  }
  return next.trimEnd().replace(/[,;:]+$/, "");
}

/** Trailing punctuation/whitespace stripped before appending the ellipsis. */
const TRAILING_PUNCT = /[\s.,;:!?…—–-]+$/;

/**
 * Truncate `text` to `maxLen` at a word or sentence boundary and append a
 * single "…". Used whenever a meta description is derived from a real (long)
 * entity `description`, so the cut never lands mid-word.
 *
 * Algorithm:
 *   1. If the trimmed input is already ≤ `maxLen`, return it verbatim (no
 *      ellipsis) — short-string / exact-length passthrough.
 *   2. Otherwise slice to `maxLen - 1` (one char reserved for the ellipsis).
 *   3. Back up to the latest sentence/clause boundary (`. ! ? ; — –`) inside
 *      the safe region (≥ 50% of the budget); if none, back up to the last
 *      word boundary (space).
 *   4. Strip trailing punctuation/whitespace and any dangling function word,
 *      then append "…".
 *
 * Guarantees: result length ≤ `maxLen`; idempotent (re-running is a no-op);
 * never emits a double ellipsis.
 */
export function truncateAtBoundary(text: string | null | undefined, maxLen = 155): string {
  const trimmed = (text ?? "").trim();
  if (trimmed.length <= maxLen) return trimmed;

  // Reserve one character for the ellipsis so the result never exceeds maxLen.
  const budget = maxLen - 1;
  const slice = trimmed.slice(0, budget);
  const safeFloor = budget * 0.5;

  // 1. Prefer the latest sentence/clause boundary within the safe region.
  let boundary = -1;
  for (const ch of ".!?;—–") {
    const idx = slice.lastIndexOf(ch);
    if (idx > boundary) boundary = idx;
  }

  let base: string;
  if (boundary >= safeFloor) {
    base = slice.slice(0, boundary + 1);
  } else {
    // 2. Fall back to the last word boundary.
    const lastSpace = slice.lastIndexOf(" ");
    base = lastSpace > safeFloor ? slice.slice(0, lastSpace) : slice;
  }

  const cleaned = trimTrailingFunctionWord(base.replace(TRAILING_PUNCT, ""));
  return `${cleaned}…`;
}
