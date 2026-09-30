/**
 * OPE-817 — the bundle price was read as the per-unit maximum.
 *
 * Manchester Grange #172 (inbound `614d0dfb`) advertises
 * "first floor $25 each or 2/$45; second floor $20 each or 2/$35".
 * Row `eec93e7e` got `vendor_fee_min=2000, vendor_fee_max=4500` — the
 * two-table bundle as the per-table max, overstating what a vendor pays by
 * ~80% on a visitor-facing field.
 *
 * ⚠️ The sibling row from the SAME email got 2000/2500 correctly. Identical
 * input, different output — so a single passing extraction proves nothing, and
 * that is why the fix is a deterministic parser rather than a tighter prompt.
 * These tests are deterministic in the way the old path could not be.
 */
import { describe, expect, it } from "vitest";
import { describeBundles, parseVendorFeeCopy, reconcileVendorFee } from "../vendor-fee-parse";
import { sanitizeEventData } from "../ai-extractor";

describe("the specimen", () => {
  const COPY = "Tables: first floor $25 each or 2/$45; second floor $20 each or 2/$35.";

  it("yields $20-$25 per table, not $20-$45", () => {
    const r = parseVendorFeeCopy(COPY);
    expect(r.matched).toBe(true);
    expect(r.perUnitMin).toBe(20);
    expect(r.perUnitMax).toBe(25);
  });

  it("keeps both bundles as bundles, never as prices", () => {
    const r = parseVendorFeeCopy(COPY);
    expect(r.bundles).toEqual([
      { quantity: 2, total: 45 },
      { quantity: 2, total: 35 },
    ]);
    // The values that used to poison the range are present, and are NOT it.
    expect(r.perUnitMax).not.toBe(45);
    expect(r.perUnitMax).not.toBe(35);
  });

  it("end to end: the model's wrong max is corrected, detail preserved", () => {
    const out = reconcileVendorFee(
      // What the extractor actually wrote.
      { vendorFeeMin: 20, vendorFeeMax: 45, vendorFeeNotes: COPY },
      null
    );
    expect(out.vendorFeeMax).toBe(25);
    expect(out.vendorFeeMin).toBe(20);
    expect(out.vendorFeeNotes).toContain("2 for $45");
  });
});

describe("the shapes that appear in real organizer copy", () => {
  it("'N for $X'", () => {
    const r = parseVendorFeeCopy("Spaces are $30 each, 3 for $75.");
    expect(r.perUnitMax).toBe(30);
    expect(r.bundles).toEqual([{ quantity: 3, total: 75 }]);
  });

  it("spelled-out quantities", () => {
    const r = parseVendorFeeCopy("Booths $40 each or two for $70.");
    expect(r.perUnitMax).toBe(40);
    expect(r.bundles).toEqual([{ quantity: 2, total: 70 }]);
  });

  it("'per table' / '$X/table'", () => {
    expect(parseVendorFeeCopy("$35 per table").perUnitMax).toBe(35);
    expect(parseVendorFeeCopy("$35/table").perUnitMax).toBe(35);
  });

  it("early-bird vs regular is a real RANGE, both per-unit", () => {
    const r = parseVendorFeeCopy("Early bird $20 per space; after Aug 1, $30 per space.");
    expect(r.perUnitMin).toBe(20);
    expect(r.perUnitMax).toBe(30);
  });

  it("member vs non-member is a real range", () => {
    const r = parseVendorFeeCopy("Members $15 each, non-members $25 each.");
    expect(r.perUnitMin).toBe(15);
    expect(r.perUnitMax).toBe(25);
  });

  it("per-location tiers combine into one per-unit range", () => {
    const r = parseVendorFeeCopy("Indoor $50 per booth, outdoor $30 per booth.");
    expect(r.perUnitMin).toBe(30);
    expect(r.perUnitMax).toBe(50);
  });

  it("handles cents and thousands separators", () => {
    expect(parseVendorFeeCopy("$1,250.00 per booth").perUnitMax).toBe(1250);
    expect(parseVendorFeeCopy("$12.50 each").perUnitMax).toBe(12.5);
  });
});

describe("what it must NOT do", () => {
  it("a bundle alone is not a per-unit range — no dividing", () => {
    // "2/$45" says nothing reliable about one table. Halving it would invent a
    // number the organizer never published.
    const r = parseVendorFeeCopy("Two tables for $45.");
    expect(r.matched).toBe(false);
    expect(r.perUnitMin).toBeNull();
    expect(r.perUnitMax).toBeNull();
    expect(r.bundles).toEqual([{ quantity: 2, total: 45 }]);
  });

  it("an unmatched parse does NOT erase the model's answer", () => {
    // ⚠️ This fixture was "Booths from $50." and the mutation "override even
    // when unmatched" SURVIVED — because that copy DOES match (the
    // `booths … $50` pattern), so the unmatched branch was never exercised.
    // Prose with no parseable price is what actually reaches it, and the
    // model's value is then the only one there is.
    const prose = "Fees vary by booth size and location — contact the organizer.";
    expect(parseVendorFeeCopy(prose).matched).toBe(false);

    const out = reconcileVendorFee(
      { vendorFeeMin: 50, vendorFeeMax: 75, vendorFeeNotes: prose },
      null
    );
    expect(out.vendorFeeMin).toBe(50);
    expect(out.vendorFeeMax).toBe(75);
    expect(out.vendorFeeNotes).toBe(prose);
  });

  it("a free booth stays 0 and does not become null", () => {
    // The `||` defect OPE-526 established: a genuine 0 is a free booth, which
    // organizers do advertise.
    const r = parseVendorFeeCopy("Tables are $0 each for members.");
    expect(r.perUnitMin).toBe(0);
    expect(r.matched).toBe(true);
  });

  it("empty or junk input is not a match", () => {
    for (const v of [null, undefined, "", "   ", "no prices here at all"]) {
      expect(parseVendorFeeCopy(v as string).matched).toBe(false);
    }
  });

  it("a year next to a price is not a bundle", () => {
    // "2026 for $25" would otherwise read as a 2026-unit bundle.
    const r = parseVendorFeeCopy("For 2026 the fee is $25 per table.");
    expect(r.bundles).toEqual([]);
    expect(r.perUnitMax).toBe(25);
  });
});

describe("bundle detail survives into the notes", () => {
  it("renders readably", () => {
    expect(describeBundles([{ quantity: 2, total: 45 }])).toBe("2 for $45");
    expect(describeBundles([])).toBe("");
  });

  it("is not duplicated when already present", () => {
    const notes = "Tables $25 each (2 for $45)";
    const out = reconcileVendorFee(
      { vendorFeeMin: 25, vendorFeeMax: 25, vendorFeeNotes: notes },
      null
    );
    expect(out.vendorFeeNotes!.match(/2 for \$45/g)).toHaveLength(1);
  });
});

describe("the reconciler is actually wired into the extractor", () => {
  // `sanitizeEventData(item, index, metadata, sourceText)` — metadata is
  // required and read for ogImage.
  const META = {
    title: null,
    description: null,
    ogImage: null,
    jsonLd: null,
  } as never;

  it("corrects the specimen end to end", () => {
    // ⚠️ The mutation "reconciler never called" SURVIVED the first time: the
    // parser was fully tested and nothing asserted that the extractor uses it.
    // That is the inert-detector shape — a correct component wired to nothing.
    const out = sanitizeEventData(
      {
        name: "Manchester Grange Craft Fair",
        vendorFeeMin: 20,
        // What the model actually produced: the bundle as the max.
        vendorFeeMax: 45,
        vendorFeeNotes: "first floor $25 each or 2/$45; second floor $20 each or 2/$35",
      },
      0,
      META
    );
    expect(out.vendorFeeMax).toBe(25);
    expect(out.vendorFeeMin).toBe(20);
    expect(out.vendorFeeNotes).toContain("2 for $45");
  });

  it("a free booth survives the extractor as 0, not null", () => {
    // The `||` -> `??` half: `sanitizePrice(0 || undefined)` was null, so a
    // free booth — which organizers do advertise — vanished.
    const out = sanitizeEventData({ name: "x", vendorFeeMin: 0, vendorFeeMax: 0 }, 0, META);
    expect(out.vendorFeeMin).toBe(0);
    expect(out.vendorFeeMax).toBe(0);
  });
});
