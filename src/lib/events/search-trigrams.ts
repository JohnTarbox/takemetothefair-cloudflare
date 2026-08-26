/**
 * OPE-548 — trigram generation for the /events search, bounded.
 *
 * Extracted from `app/events/(listing)/page.tsx` so the bound is testable. It
 * was inline and unbounded, and the bound is the part that matters: every
 * trigram becomes one bound parameter, D1 caps a statement at 100 of them, and
 * a 200-character search generated 198 conditions in a single WHERE.
 *
 * ⚠️ A test cannot catch that by executing a query. Local SQLite's bind-param
 * ceiling is 32,766 against D1's 100, so "build a big query and assert it does
 * not throw" passes with the bug in — the same trap `[[d1-batch-param-limit]]`
 * records. The only thing worth asserting is the SHAPE: how many trigrams come
 * out. That is what `search-trigrams.test.ts` does.
 *
 * The 32-character ceiling is a judgement, not a limit: past roughly that length
 * a query is a phrase rather than a word, the exact substring match already
 * carries the signal, and 60%-of-trigrams matching over 30+ fragments matches
 * noise rather than typos.
 */

/** Longest search term that still gets trigram fuzzy matching. */
export const TRIGRAM_MAX_QUERY_LEN = 32;

/** Shortest term worth fuzzy-matching at all. */
export const TRIGRAM_MIN_QUERY_LEN = 4;

/**
 * Hard ceiling on emitted trigrams, derived from TRIGRAM_MAX_QUERY_LEN.
 * A query of length n yields n-2 trigrams, so 32 → 30.
 */
export const MAX_TRIGRAMS = TRIGRAM_MAX_QUERY_LEN - 2;

/**
 * Overlapping 3-character fragments of `query`, for typo-tolerant matching.
 * "choclate" → cho, hoc, ocl, cla, lat, ate — which still matches "chocolate".
 *
 * Returns `[]` when the query is too short to be worth fuzzy-matching or long
 * enough that fuzzy matching is both useless and unsafe. Callers should treat
 * an empty result as "exact matching only", not as an error.
 */
export function searchTrigrams(query: string): string[] {
  const q = query.toLowerCase().trim();
  if (q.length < TRIGRAM_MIN_QUERY_LEN) return [];
  if (q.length > TRIGRAM_MAX_QUERY_LEN) return [];
  const out: string[] = [];
  for (let i = 0; i <= q.length - 3; i++) out.push(q.substring(i, i + 3));
  return out;
}

/**
 * How many of the trigrams must match for a row to count as a fuzzy hit.
 * 60%, floored, never below 2 — so a 4-character query needs both its trigrams
 * rather than either one, which would match almost anything.
 */
export function trigramMinMatches(trigramCount: number): number {
  return Math.max(2, Math.floor(trigramCount * 0.6));
}
