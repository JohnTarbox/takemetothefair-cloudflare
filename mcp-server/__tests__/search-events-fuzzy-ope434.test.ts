/**
 * OPE-434 — fuzzy scoring was strictly WORSE than exact matching.
 *
 * Reported symptom: `search_events` with `fuzzy: true` on
 * "Martha's Vineyard Agricultural Fair" scored "W.I.H.A. Strawberry Festival"
 * a perfect **1.0** while omitting every real Martha's Vineyard row. The same
 * query without fuzzy found them immediately.
 *
 * ---------------------------------------------------------------------------
 * Root cause
 * ---------------------------------------------------------------------------
 *
 * Punctuation is replaced with spaces before splitting, so possessives and
 * initialisms shattered into single letters:
 *
 *   "Martha's Vineyard Agricultural Fair" -> [martha, s, vineyard, agricultural, fair]
 *   "W.I.H.A. Strawberry Festival"        -> [w, i, h, strawberry, festival]
 *
 * The old match test was bidirectional substring containment
 * (`t.includes(q) || q.includes(t)`), so every single query token "matched"
 * one of those single letters — `martha` contains `h`, `vineyard` /
 * `agricultural` / `fair` all contain `i`, and `s` sits inside `strawberry`.
 * 5 of 5 tokens matched, giving 1.0. The genuine row scored only 0.800, so the
 * ranking was actually INVERTED, not merely noisy.
 *
 * Substring containment was the deeper flaw, independent of token length:
 * "agricultural" contains "cultural", which made "Johnny Appleseed Arts and
 * Cultural Festival" a candidate duplicate. Matching is now by PREFIX, which
 * absorbs plurals and suffixes ("market"/"markets", "art"/"artisan") without
 * ever matching a word interior.
 *
 * The same `s` token also poisoned the SQL pre-filter, which ORs a
 * `LIKE '%<token>%'` per token: `%s%` matches nearly every row in the catalog,
 * so the candidate set overflowed the 200-row cap (no ORDER BY) and the real
 * matches were sliced out before scoring ran at all. That is why they were
 * absent entirely rather than just ranked low.
 *
 * Four changes: drop sub-2-character tokens, match by prefix instead of
 * substring, require a minimum length before allowing prefix (rather than
 * exact) matching, and down-weight generic catalog words. Plus the whole-query
 * LIKE is now ORed into the pre-filter so an exact match can never be sliced
 * out of the capped candidate set.
 *
 * Why it is P2 and not a search-quality nit: this tool IS the duplicate check.
 * A confident 1.0 on an unrelated event, with the real one missing, tells the
 * caller "we don't have this" — and it creates a duplicate.
 */
import { describe, it, expect } from "vitest";
import { fuzzyTokenScore, tokenize } from "../src/helpers.js";

const QUERY = "Martha's Vineyard Agricultural Fair";

/** The exact rows the ticket reported, with their reported scores. */
const REPORTED_FALSE_POSITIVES = [
  "W.I.H.A. Strawberry Festival", // scored 1.0
  "Cheshire Strawberry Festival and Craft Fair", // 0.4
  "St. Andrew's Strawberry Festival and Craft Fair", // 0.4
  "Johnny Appleseed Arts and Cultural Festival", // 0.4
  "First Parish UU Blueberry Festival and Craft Fair", // 0.4
];

const REAL_MATCHES = [
  "Martha's Vineyard Fair 2026",
  "Martha's Vineyard Fair 2027",
  "Martha's Vineyard Fair 2028",
  "Martha's Vineyard Fair 2029",
];

/** Production post-filter threshold in search_events. */
const THRESHOLD = 0.2;

describe("tokenize drops meaningless fragments", () => {
  it("no longer emits the single letters that caused the false 1.0", () => {
    expect(tokenize(QUERY)).toEqual(["martha", "vineyard", "agricultural", "fair"]);
    expect(tokenize("W.I.H.A. Strawberry Festival")).toEqual(["strawberry", "festival"]);
  });

  it("keeps two-character tokens, which can still be meaningful", () => {
    // Dropping these too would lose real signal (e.g. "MV", "St" as a name).
    expect(tokenize("MV Agricultural Society")).toContain("mv");
  });
});

describe("the reported false positives are gone", () => {
  it("W.I.H.A. Strawberry Festival no longer scores anywhere near 1.0", () => {
    const score = fuzzyTokenScore(QUERY, "W.I.H.A. Strawberry Festival");
    expect(score).toBe(0);
  });

  it("every row the ticket listed now falls below the production threshold", () => {
    for (const name of REPORTED_FALSE_POSITIVES) {
      expect(fuzzyTokenScore(QUERY, name), name).toBeLessThan(THRESHOLD);
    }
  });
});

describe("the real matches rank at the top", () => {
  it("all four Martha's Vineyard rows score well above threshold", () => {
    for (const name of REAL_MATCHES) {
      expect(fuzzyTokenScore(QUERY, name), name).toBeGreaterThan(0.5);
    }
  });

  it("every real match outranks every reported false positive", () => {
    const worstReal = Math.min(...REAL_MATCHES.map((n) => fuzzyTokenScore(QUERY, n)));
    const bestFalse = Math.max(...REPORTED_FALSE_POSITIVES.map((n) => fuzzyTokenScore(QUERY, n)));
    expect(worstReal).toBeGreaterThan(bestFalse);
  });

  it("an exact-name match scores 1.0", () => {
    // The score has to mean something for dedup callers: 1.0 must indicate
    // near-identical, so it can be trusted as a confidence signal.
    expect(fuzzyTokenScore(QUERY, "Martha's Vineyard Agricultural Fair 2026")).toBe(1);
  });
});

describe("generic catalog words are weak evidence", () => {
  it("sharing only 'Fair' is not enough to clear the threshold", () => {
    // "Fair"/"Festival"/"Craft" appear across a large share of the catalog. A
    // row sharing nothing else must not surface as a duplicate candidate.
    expect(fuzzyTokenScore(QUERY, "Cheshire Strawberry Festival and Craft Fair")).toBeLessThan(
      THRESHOLD
    );
  });

  it("but a generic-only query still scores against a matching row", () => {
    // Down-weighted, not dropped — otherwise a query of nothing but generic
    // words would score 0 against everything and return an empty set.
    expect(fuzzyTokenScore("Craft Fair", "Bar Harbor Craft Fair")).toBe(1);
  });
});

describe("the superset invariant", () => {
  // Acceptance: enabling fuzzy must never DROP a row that exact substring
  // matching would have returned. If the query is a substring of the name,
  // every query token is present by construction, so the score is 1.0 — well
  // clear of the threshold. (The SQL half is handled by ORing the whole-query
  // LIKE into the pre-filter, so an exact match cannot be sliced out of the
  // capped candidate set either.)
  const cases: Array<[string, string]> = [
    ["Martha's Vineyard Fair", "Martha's Vineyard Fair 2026"],
    ["Windsor Fair", "Windsor Fair 2027"],
    ["Yankee Homecoming", "Yankee Homecoming 2026"],
    ["Bar Harbor", "Bar Harbor Fall Craft Fair 2026"],
  ];

  it.each(cases)("exact substring %s scores 1.0 against %s", (query, name) => {
    expect(fuzzyTokenScore(query, name)).toBe(1);
  });
});

describe("matching is by prefix, not substring", () => {
  it("a two-letter token does not match a long word starting with it", () => {
    // Generalised form of the original bug: `s` matching `strawberry`.
    expect(fuzzyTokenScore("MV", "Strawberry Festival")).toBe(0);
  });

  it("a three-letter token still matches a longer word it prefixes", () => {
    // Kept deliberately — "art"/"artisan", "fair"/"fairgrounds" are real.
    expect(fuzzyTokenScore("Art Show", "Artisan Show")).toBe(1);
  });

  it("does NOT match a word interior — 'cultural' is not 'agricultural'", () => {
    // The case that survived the token-length fix: substring containment made
    // "Johnny Appleseed Arts and Cultural Festival" a candidate duplicate of
    // "Martha's Vineyard Agricultural Fair". Word interiors are not evidence.
    expect(fuzzyTokenScore("Agricultural Fair", "Cultural Festival")).toBe(0);
  });

  it("absorbs plurals, which is what prefix matching is for", () => {
    expect(fuzzyTokenScore("Farmers Market", "Farmers Markets")).toBe(1);
  });
});
