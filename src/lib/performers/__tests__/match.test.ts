import { describe, it, expect } from "vitest";
import { rankPerformerMatches } from "../match";

const cands = [
  { id: "1", name: "The Fiddleheads Band", slug: "the-fiddleheads-band" },
  { id: "2", name: "Mr. Drew and His Animals Too", slug: "mr-drew-and-his-animals-too" },
  { id: "3", name: "The Jugglers", slug: "the-jugglers" },
];

describe("rankPerformerMatches (OPE-113)", () => {
  it("surfaces a near-identical name as a likely duplicate, best first", () => {
    const m = rankPerformerMatches("The Fiddleheads Band!", cands);
    expect(m.length).toBeGreaterThan(0);
    expect(m[0].id).toBe("1");
    expect(m[0].score).toBeGreaterThanOrEqual(0.92);
  });

  it("returns nothing for a clearly-distinct name (safe to create)", () => {
    expect(rankPerformerMatches("Completely Different Circus", cands)).toEqual([]);
  });

  it("does NOT auto-match the known dash/abbrev miss (relies on manual alias)", () => {
    // 'Mr Drew' is far below 0.92 vs the full name — surfaced by neither the
    // score nor this helper; the operator uses set_performer_alias for it.
    expect(rankPerformerMatches("Mr Drew", cands)).toEqual([]);
  });

  it("empty query → no matches", () => {
    expect(rankPerformerMatches("  ", cands)).toEqual([]);
  });
});
