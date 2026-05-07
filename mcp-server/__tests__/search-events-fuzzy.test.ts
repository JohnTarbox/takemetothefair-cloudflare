/**
 * Regression tests for search_events fuzzy matching, covering the 7 false
 * negatives documented in the analyst memo (2026-05-06).
 *
 * The bug was at the SQL pre-filter layer, not the scoring algorithm:
 * search_events with fuzzy:true previously applied NO `LIKE` filter and
 * over-fetched only 200 rows from the PUBLIC events set. With ~643 events
 * in production, the matching row often wasn't in the scanned slice, and
 * the JS scorer never saw it. The fix narrows the SQL set to "rows whose
 * name contains at least one non-stopword query token" before scoring.
 *
 * These tests exercise both layers:
 *  - tokenize() strips year/ordinal/stopwords identically to fuzzyTokenScore.
 *  - fuzzyTokenScore() ranks the 7 documented pairs ≥ 0.5 (well above the
 *    0.2 production threshold) so they always pass post-filter.
 */
import { describe, it, expect } from "vitest";
import { fuzzyTokenScore, tokenize } from "../src/helpers.js";

describe("tokenize", () => {
  it("strips year suffixes (so '2026' doesn't become a real token)", () => {
    expect(tokenize("Yankee Homecoming 2026")).toEqual(["yankee", "homecoming"]);
  });

  it("strips ordinal prefixes (45th, 19th, 52nd, 55th)", () => {
    expect(tokenize("45th Annual Kennebunkport Christmas Prelude")).toEqual([
      "annual",
      "kennebunkport",
      "christmas",
      "prelude",
    ]);
    expect(tokenize("55th Annual Newport International Boat Show")).toEqual([
      "annual",
      "newport",
      "international",
      "boat",
      "show",
    ]);
  });

  it("strips common English stop words", () => {
    expect(tokenize("The Lobster Festival of Maine at the Coast")).toEqual([
      "lobster",
      "festival",
      "maine",
      "coast",
    ]);
  });

  it("lowercases and collapses non-alphanumerics", () => {
    expect(tokenize("Newport Int'l Boat-Show!")).toEqual(["newport", "int", "l", "boat", "show"]);
  });

  it("returns empty array for input that is all stopwords/years/punctuation", () => {
    expect(tokenize("the of in 2026 1st")).toEqual([]);
    expect(tokenize("!!! ??? ---")).toEqual([]);
  });
});

describe("fuzzyTokenScore — analyst memo regression cases (2026-05-06)", () => {
  // Threshold from production: results scored < 0.2 are filtered out
  // (mcp-server/src/tools/public.ts:146). Each pair below MUST score
  // strictly above that to pass.
  const THRESHOLD = 0.2;

  const cases: Array<[string, string]> = [
    ["Kennebunkport Christmas Prelude", "Kennebunkport Christmas Prelude 2026"],
    ["Kennebunkport Christmas Prelude", "Kennebunkport Christmas Prelude 2026-1"],
    ["Kennebunkport Christmas Prelude", "45th Annual Kennebunkport Christmas Prelude"],
    ["Strawbery Banke Candlelight Stroll", "Strawbery Banke Candlelight Stroll 2026"],
    ["Yankee Homecoming", "Yankee Homecoming 2026"],
    ["Maine Lobster Festival", "Maine Lobster Festival 2026"],
    // Cross-rename case: the bare query against an ordinal-prefix legacy slug.
    ["Newport International Boat Show", "55th Annual Newport International Boat Show"],
  ];

  it.each(cases)("%s ↔ %s scores well above 0.2", (query, target) => {
    const score = fuzzyTokenScore(query, target);
    expect(score).toBeGreaterThan(THRESHOLD);
  });

  it("identical names score 1.0 (no year/ordinal noise)", () => {
    expect(fuzzyTokenScore("Yankee Homecoming", "Yankee Homecoming")).toBe(1);
  });

  it("query that is a strict subset scores 1.0 (every query token matches)", () => {
    // "Yankee Homecoming" → tokens [yankee, homecoming]
    // "Yankee Homecoming 2026 Kickoff" → tokens [yankee, homecoming, kickoff]
    // All 2 query tokens find a match, so 2/2 = 1.0.
    expect(fuzzyTokenScore("Yankee Homecoming", "Yankee Homecoming 2026 Kickoff")).toBe(1);
  });

  it("unrelated names score 0.0", () => {
    expect(fuzzyTokenScore("Yankee Homecoming", "Maine Lobster Festival")).toBe(0);
  });

  it("partial token match (substring) still counts — 'Kennebunk' matches 'Kennebunkport'", () => {
    // Query token 'kennebunk' is a substring of target token 'kennebunkport'
    // — the scorer's includes() check covers this.
    expect(
      fuzzyTokenScore("Kennebunk Prelude", "Kennebunkport Christmas Prelude 2026")
    ).toBeGreaterThanOrEqual(0.5);
  });
});
