/**
 * OPE-477 — the last-resort name check, for candidates whose venue never resolved.
 *
 * ## Why Levenshtein was not enough
 *
 * `Waterville Elks Craft Fair` vs `Waterville Elks Lodge #905 28th Annual Craft
 * Fair 2026`, six days apart at the same lodge, scored **0.5417** against a 0.85
 * threshold. Not a tuning miss — the two strings really are that different by
 * edit distance, because one carries the venue name and an ordinal inside it.
 *
 * `normalizeName` strips a LEADING ordinal and "Annual" and a TRAILING year, so
 * it removed `2026` and left `lodge 905 28th annual` — twenty-one characters of
 * noise sitting in the middle. Edit distance has no way to discount that;
 * containment does, because every token of the shorter name is present in the
 * longer one.
 *
 * ## Why this is not just "lower the threshold"
 *
 * Lowering 0.85 moves every pair, everywhere. Measured against the live corpus,
 * a broad first-token match inside ±7 days produces **359** pairs, of which
 * **223** the venue stage already catches — so a blanket loosening would add
 * ~136 new candidates and turn `force_create: true` into routine, which is
 * precisely OPE-454's failure mode.
 *
 * Restricted to candidates whose venue stages could not evaluate, the same
 * signal touches **6 pairs corpus-wide**. That gating is the design; this
 * function without it would be a regression.
 *
 * ## The rule
 *
 * Every token of the shorter name appears in the longer one, AND at least
 * `MIN_DISTINCTIVE` of the shared tokens are not generic event vocabulary.
 * "Craft Fair" ⊂ "Spring Craft Fair" shares two tokens and **zero** distinctive
 * ones, so it does not match — which is the case that would otherwise make this
 * fire constantly.
 */

/**
 * Words that carry no identifying information about WHICH event this is.
 *
 * Deliberately not a stopword list of English — these are the words that appear
 * in a large fraction of event names in this catalog, so sharing them is
 * evidence of nothing. `annual` and the bare ordinals are here because
 * `normalizeName` only strips them when they lead.
 */
const GENERIC_TOKENS = new Set([
  "fair",
  "fairs",
  "craft",
  "crafts",
  "festival",
  "festivals",
  "show",
  "shows",
  "market",
  "markets",
  "annual",
  "sale",
  "expo",
  "event",
  "events",
  "the",
  "and",
  "of",
  "at",
  "in",
  "on",
  "a",
  "an",
  "day",
  "days",
  "weekend",
  "holiday",
  "christmas",
  "spring",
  "summer",
  "fall",
  "autumn",
  "winter",
]);

/** How many non-generic tokens must be shared before this is worth surfacing. */
export const MIN_DISTINCTIVE = 2;

/** An ordinal like `28th`, or a bare number like `905` — noise, not identity. */
function isOrdinalOrNumber(token: string): boolean {
  return /^\d+(?:st|nd|rd|th)?$/.test(token);
}

/** Split an already-normalized name into comparable tokens. */
export function tokenize(normalized: string): string[] {
  return normalized.split(/\s+/).filter((t) => t.length > 0);
}

/** Tokens that actually identify an event: not generic, not a number, ≥3 chars. */
export function distinctiveTokens(normalized: string): Set<string> {
  return new Set(
    tokenize(normalized).filter(
      (t) => t.length >= 3 && !GENERIC_TOKENS.has(t) && !isOrdinalOrNumber(t)
    )
  );
}

export interface ContainmentMatch {
  /** Non-generic tokens both names share, sorted for stable reporting. */
  sharedDistinctive: string[];
  /** Fraction of the shorter name's tokens found in the longer one, 0..1. */
  containment: number;
}

/**
 * Is one normalized name plausibly the other with extra words?
 *
 * Returns null when not — including for the "both names are just generic
 * vocabulary" case, which is the one that would otherwise fire on everything.
 *
 * Symmetric: which argument is longer does not matter.
 */
export function nameContainmentMatch(
  normalizedA: string,
  normalizedB: string
): ContainmentMatch | null {
  const a = tokenize(normalizedA);
  const b = tokenize(normalizedB);
  if (a.length === 0 || b.length === 0) return null;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const longerSet = new Set(longer);

  // Containment of the SHORTER name in the longer. A shorter name that is
  // wholly present in the longer one is the "same event, plus venue and
  // ordinal noise" shape; the reverse direction says nothing.
  const contained = shorter.filter((t) => longerSet.has(t));
  const containment = contained.length / shorter.length;
  if (containment < 1) return null;

  // Containment alone is not enough. "craft fair" is contained in almost
  // everything, and matching on it would flag every craft fair in the state
  // against every other one in the same week.
  const distinctA = distinctiveTokens(normalizedA);
  const distinctB = distinctiveTokens(normalizedB);
  const sharedDistinctive = [...distinctA].filter((t) => distinctB.has(t)).sort();
  if (sharedDistinctive.length < MIN_DISTINCTIVE) return null;

  return { sharedDistinctive, containment };
}
