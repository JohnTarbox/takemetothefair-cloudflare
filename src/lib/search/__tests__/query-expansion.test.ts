/**
 * OPE-281 — internal-search query expansion. Cases cover the four grounded
 * zero-result queries from the OPE-274 VoC audit (all have matching events that
 * the old bare-substring search couldn't reach). The fuzzy-misspelling leg
 * ("mrshfeild") lives in the route (it needs the DB); here we assert the parse
 * that feeds it, plus the similarity threshold that makes it land.
 */
import { describe, it, expect } from "vitest";
import { expandEventSearchQuery, EVENT_TYPE_SYNONYMS } from "../query-expansion";
import { levenshteinSimilarity } from "@takemetothefair/utils";

describe("expandEventSearchQuery", () => {
  it("maps 'arts and crafts fair' to Craft/Art categories + a fair-synonym group", () => {
    const e = expandEventSearchQuery("arts and crafts fair");
    expect(e.categoryNames).toEqual(expect.arrayContaining(["Craft Fair", "Art Show"]));
    expect(e.stateCode).toBeNull();
    // "fair" expands to the full event-type synonym set.
    expect(e.nameTermGroups.some((g) => g.includes("market") && g.includes("festival"))).toBe(true);
  });

  it("splits 'blueberry connecticut' into term 'blueberry' + state CT", () => {
    const e = expandEventSearchQuery("blueberry connecticut");
    expect(e.stateCode).toBe("CT");
    expect(e.coreTerms).toEqual(["blueberry"]);
    expect(e.nameTermGroups).toEqual([["blueberry"]]);
  });

  it("handles 'holiday fair salem ma' — state MA, fair⇄market synonym, salem kept", () => {
    const e = expandEventSearchQuery("holiday fair salem ma");
    expect(e.stateCode).toBe("MA");
    // holiday + salem are distinctive terms; fair became a synonym group.
    expect(e.coreTerms).toEqual(expect.arrayContaining(["holiday", "salem"]));
    const groupWithMarket = e.nameTermGroups.find((g) => g.includes("market"));
    expect(groupWithMarket).toBeDefined();
    // "Salem Holiday Market" satisfies: has 'holiday', a market-synonym, and 'salem'.
  });

  it("treats a bare misspelling as a single core term (no state/category)", () => {
    const e = expandEventSearchQuery("mrshfeild");
    expect(e.stateCode).toBeNull();
    expect(e.categoryNames).toEqual([]);
    expect(e.coreTerms).toEqual(["mrshfeild"]);
  });

  it("does not eat a lone 2-letter token as a state (avoids matching just 'ma')", () => {
    const e = expandEventSearchQuery("ma");
    expect(e.stateCode).toBeNull();
    expect(e.coreTerms).toEqual(["ma"]);
  });

  it("recognizes a two-word state name ('new hampshire')", () => {
    const e = expandEventSearchQuery("balloon festival new hampshire");
    expect(e.stateCode).toBe("NH");
    expect(e.coreTerms).toEqual(["balloon"]); // festival → synonym group, not a core term
  });

  it("EVENT_TYPE_SYNONYMS includes the fair⇄market⇄festival⇄show set", () => {
    for (const w of ["fair", "market", "festival", "show"]) {
      expect(EVENT_TYPE_SYNONYMS).toContain(w);
    }
  });
});

describe("fuzzy threshold (drives the route's zero-result fallback)", () => {
  it("scores the canonical 'mrshfeild' → 'marshfield' at ≥ 0.7", () => {
    expect(levenshteinSimilarity("mrshfeild", "marshfield")).toBeGreaterThanOrEqual(0.7);
  });
});
