/**
 * OPE-548 — the /events search must not be able to build a query D1 refuses.
 *
 * Two D1 ceilings meet in this one WHERE clause:
 *
 *   pattern complexity  — a LIKE pattern built from user input. Removed by
 *                         switching to `instr()` via containsCI, which has no
 *                         pattern limit at all.
 *   100 bound params    — every trigram is one. A 200-character search emitted
 *                         198 conditions in a single statement.
 *
 * ⚠️ Neither is catchable by executing a query in a test. Local SQLite allows
 * 32,766 bind params against D1's 100 and a far larger LIKE pattern, so
 * "build a big query, assert no throw" passes with both bugs in — the trap
 * `[[d1-batch-param-limit]]` records. These assert the SHAPE instead: how many
 * fragments come out, for inputs no user would type and every crawler will.
 */
import { describe, it, expect } from "vitest";
import {
  searchTrigrams,
  trigramMinMatches,
  MAX_TRIGRAMS,
  TRIGRAM_MAX_QUERY_LEN,
} from "../search-trigrams";

describe("the fan-out is bounded — the assertion that stands in for D1", () => {
  it("never emits more than MAX_TRIGRAMS, for any input length", () => {
    // The real defect: 200 chars used to yield 198 conditions.
    for (const len of [33, 40, 60, 100, 200, 1000, 10_000]) {
      const out = searchTrigrams("a".repeat(len));
      expect(out.length).toBeLessThanOrEqual(MAX_TRIGRAMS);
    }
  });

  it("stays clear of D1's 100-parameter statement ceiling with room to spare", () => {
    // The trigrams are not the only parameters in the statement — the exact
    // match, the status filter, the date window, the ORDER BY and LIMIT/OFFSET
    // all bind too. 30 leaves the rest of the query ~70.
    expect(MAX_TRIGRAMS).toBeLessThanOrEqual(30);
    expect(MAX_TRIGRAMS + 20).toBeLessThan(100);
  });

  it("a 200-character search produces ZERO trigrams, not 198", () => {
    expect(searchTrigrams("a".repeat(200))).toEqual([]);
  });
});

describe("the boundary is exactly where it says it is", () => {
  it("emits at the max length and stops one past it", () => {
    expect(searchTrigrams("a".repeat(TRIGRAM_MAX_QUERY_LEN))).toHaveLength(MAX_TRIGRAMS);
    expect(searchTrigrams("a".repeat(TRIGRAM_MAX_QUERY_LEN + 1))).toEqual([]);
  });

  it("skips fuzzy matching for terms too short to be worth it", () => {
    expect(searchTrigrams("a")).toEqual([]);
    expect(searchTrigrams("abc")).toEqual([]);
    expect(searchTrigrams("abcd")).toEqual(["abc", "bcd"]);
  });
});

describe("ordinary searches are unchanged — the fix must not cost recall", () => {
  it("still generates the typo-tolerant fragments the feature exists for", () => {
    // The docstring's own example: this is what matches "chocolate".
    expect(searchTrigrams("choclate")).toEqual(["cho", "hoc", "ocl", "cla", "lat", "ate"]);
  });

  it("normalises case and surrounding whitespace", () => {
    expect(searchTrigrams("  CRAFT  ")).toEqual(["cra", "raf", "aft"]);
  });

  it("a realistic multi-word search still fuzzy-matches", () => {
    // 21 chars — comfortably inside the bound, so nothing a real user loses.
    const out = searchTrigrams("maine agricultural");
    expect(out.length).toBeGreaterThan(10);
    expect(out.length).toBeLessThanOrEqual(MAX_TRIGRAMS);
  });
});

describe("trigramMinMatches", () => {
  it("is 60%, floored", () => {
    expect(trigramMinMatches(10)).toBe(6);
    expect(trigramMinMatches(30)).toBe(18);
  });

  it("never drops below 2 — one matching fragment matches almost everything", () => {
    expect(trigramMinMatches(2)).toBe(2);
    expect(trigramMinMatches(1)).toBe(2);
    expect(trigramMinMatches(0)).toBe(2);
  });
});
