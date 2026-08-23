/**
 * OPE-512 — auto-merge precondition #3: one contact value, several vendors.
 *
 * OPE-374's sample found a single proposed phone or email appearing across
 * multiple vendor rows. Auto-merging writes that value onto every one of them,
 * and the point is that MOST of these clusters are benign — one business with
 * several listings. That is exactly why they must not merge: the shared value
 * is the cheapest duplicate-vendor signal we have, and merging it silently
 * turns a dedup lead into two rows nobody can tell apart afterwards.
 *
 * Measured on prod 2026-08-23 across the pending queue:
 *
 *   37 clusters · 77 vendors · 10 currently auto-merge-eligible rows held
 *
 * And the names say it plainly — these are near-duplicate VENDORS, not a
 * coincidence of digits:
 *
 *   Gryffon Ridge Spice Merchants / Gryphon Ridge Spice Merchants
 *   Hamlin's Marina              / Hamlin's Marine
 *   603 Perfect Blend LLC        / 603 Perfect Blend
 *   The Kona Brand               / Kona Brand
 *   Floweredsky Designs          / Floweredsky Design
 *   Mighty Squirrel              / Mighty Squirrel Fenway
 *
 * Values below are real prod rows, per the OPE-504 red-first discipline.
 */
import { describe, it, expect } from "vitest";
import { applyFillsForTest } from "../src/enrichment/dispatch.js";

type C = { field: string; proposedValue: string; currentValue: string | null; flags: string[] };

function candidate(over: Partial<C> = {}): C {
  return {
    field: "contact_phone",
    proposedValue: "(603) 899-2465",
    currentValue: null,
    flags: [],
    ...over,
  };
}

describe("the existing rule that does the blocking", () => {
  it("a flagged candidate never auto-merges", () => {
    // OPE-512 flags at STAGING and relies on this. Pinned here because the
    // whole design rests on it: if `applyFills` ever stopped honouring flags,
    // this guard and several others would silently stop guarding.
    expect(applyFillsForTest([candidate({ flags: ["duplicate_value_across_vendors"] })])).toEqual(
      []
    );
  });

  it("an unflagged fill still merges — the guard is not a blanket block", () => {
    expect(applyFillsForTest([candidate()])).toEqual(["contact_phone"]);
  });

  it("a candidate with a prior value is not a fill and never merges", () => {
    expect(applyFillsForTest([candidate({ currentValue: "(555) 000-0000" })])).toEqual([]);
  });

  it("description never auto-publishes, flags or not", () => {
    expect(
      applyFillsForTest([candidate({ field: "description", proposedValue: "Some prose" })])
    ).toEqual([]);
  });

  it("blocks only the duplicated field, leaving a clean sibling to merge", () => {
    // The Third Shift / Udderly Gutters row shape: the phone is shared, the
    // address on the same page is not. Over-blocking would cost real fills.
    const out = applyFillsForTest([
      candidate({ flags: ["duplicate_value_across_vendors"] }),
      candidate({ field: "address", proposedValue: "28 Lisa Dr" }),
    ]);
    expect(out).toEqual(["address"]);
  });
});
