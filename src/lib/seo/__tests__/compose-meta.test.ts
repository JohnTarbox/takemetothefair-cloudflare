import { describe, it, expect } from "vitest";
import {
  composeEventFallback,
  composeVendorFallback,
  composeVenueFallback,
  composePromoterFallback,
} from "../compose-meta";

/**
 * Shared invariants for every composed fallback: no artifacts from dropped
 * fields, and a sane meta length. `minLen` defaults to 120 (the ticket's band
 * floor) but degenerate inputs (name only) legitimately land shorter, so those
 * cases pass a lower floor explicitly.
 */
function assertClean(s: string, minLen = 120) {
  // No dangling-comma / empty-clause artifacts from a null field.
  expect(s).not.toContain(", .");
  expect(s).not.toContain(" ,");
  expect(s).not.toMatch(/\bin ,/);
  expect(s).not.toMatch(/\bfrom ,/);
  // No double spaces.
  expect(s).not.toMatch(/ {2,}/);
  // Reads as a proper sentence: no doubled period, no dangling "in"/"from".
  expect(s).not.toMatch(/\b(in|from) \./);
  // Length band.
  expect(s.length).toBeGreaterThanOrEqual(minLen);
  expect(s.length).toBeLessThanOrEqual(160);
}

describe("composeEventFallback", () => {
  it("full fields", () => {
    const out = composeEventFallback({
      name: "Fryeburg Fair",
      category: "Agricultural Fair",
      city: "Fryeburg",
      state: "ME",
      dates: "Oct 4-11, 2026",
    });
    expect(out).toBe(
      "Fryeburg Fair is an Agricultural Fair in Fryeburg, ME on Oct 4-11, 2026. Find hours, tickets, vendor applications, and directions on Meet Me at the Fair."
    );
    assertClean(out);
  });

  it("missing city/state — drops the location clause cleanly", () => {
    const out = composeEventFallback({
      name: "Spring Craft Fair",
      category: "Craft Fair",
      dates: "Jun 15, 2026",
    });
    expect(out).toContain("Spring Craft Fair is a Craft Fair on Jun 15, 2026.");
    expect(out).not.toContain(" in ");
    assertClean(out);
  });

  it("missing category — falls back to 'an event'", () => {
    const out = composeEventFallback({
      name: "Harvest Days",
      city: "Boston",
      state: "MA",
      dates: "May 3, 2026",
    });
    expect(out).toContain("Harvest Days is an event in Boston, MA on May 3, 2026.");
    assertClean(out);
  });

  it("only city (no state) — no dangling comma", () => {
    const out = composeEventFallback({
      name: "Harvest Days",
      category: "Festival",
      city: "Boston",
      dates: "May 3, 2026",
    });
    expect(out).toContain("in Boston on");
    assertClean(out);
  });

  it("name only — still clean, non-trivial", () => {
    const out = composeEventFallback({ name: "Mystery Pop-Up" });
    expect(out).toContain("Mystery Pop-Up is an event.");
    assertClean(out, 90);
  });

  it("decodes HTML entities in the name", () => {
    const out = composeEventFallback({
      name: "Earth Expo &amp; Convention",
      city: "Boston",
      state: "MA",
    });
    expect(out).toContain("Earth Expo & Convention");
    expect(out).not.toContain("&amp;");
  });
});

describe("composeVendorFallback", () => {
  it("full fields", () => {
    const out = composeVendorFallback({
      businessName: "Maine Cardworks",
      vendorType: "Trading Cards",
      city: "Portland",
      state: "ME",
    });
    expect(out).toBe(
      "Maine Cardworks is a Trading Cards vendor from Portland, ME exhibiting at New England fairs & festivals. See shows and booth info on Meet Me at the Fair."
    );
    assertClean(out);
  });

  it("missing city/state — drops the 'from' clause", () => {
    const out = composeVendorFallback({ businessName: "Vintage Jewelry", vendorType: "Antiques" });
    expect(out).toContain("Vintage Jewelry is an Antiques vendor exhibiting at");
    expect(out).not.toContain(" from ");
    assertClean(out);
  });

  it("missing type — falls back to 'a vendor'", () => {
    const out = composeVendorFallback({
      businessName: "Sunrise Soaps",
      city: "Concord",
      state: "NH",
    });
    expect(out).toContain("Sunrise Soaps is a vendor from Concord, NH exhibiting at");
    assertClean(out);
  });

  it("name only — clean, non-trivial", () => {
    const out = composeVendorFallback({ businessName: "Vendor Name Only" });
    expect(out).toContain("Vendor Name Only is a vendor exhibiting at");
    assertClean(out);
  });
});

describe("composeVenueFallback", () => {
  it("full fields", () => {
    const out = composeVenueFallback({
      name: "Cumberland County Fairgrounds",
      city: "Cumberland",
      state: "ME",
    });
    expect(out).toBe(
      "Cumberland County Fairgrounds in Cumberland, ME hosts fairs, festivals, and craft shows. Browse the full schedule and vendor info on Meet Me at the Fair."
    );
    assertClean(out);
  });

  it("missing city/state — drops the location clause", () => {
    const out = composeVenueFallback({ name: "Mystery Pavilion" });
    expect(out).toContain("Mystery Pavilion hosts fairs, festivals, and craft shows.");
    expect(out).not.toContain(" in ");
    assertClean(out);
  });
});

describe("composePromoterFallback", () => {
  it("full fields", () => {
    const out = composePromoterFallback({
      name: "Castleberry Fairs & Festivals",
      city: "Hollis",
      state: "NH",
    });
    expect(out).toContain("Castleberry Fairs & Festivals in Hollis, NH organizes");
    expect(out).toContain("Meet Me at the Fair.");
    assertClean(out);
  });

  it("missing city/state — drops the location clause", () => {
    const out = composePromoterFallback({ name: "Acme Promotions" });
    expect(out).toContain("Acme Promotions organizes fairs, festivals, and events");
    expect(out).not.toContain(" in ");
    assertClean(out);
  });
});

describe("compose fallbacks — length is always capped at 160", () => {
  it("a very long entity name never overflows and boundary-truncates", () => {
    const longName =
      "The Greater Northern New England Regional Agricultural Society Annual Exhibition and Harvest Festival";
    for (const out of [
      composeEventFallback({
        name: longName,
        category: "Fair",
        city: "Springfield",
        state: "MA",
        dates: "Sep 1, 2026",
      }),
      composeVendorFallback({
        businessName: longName,
        vendorType: "Crafts",
        city: "Springfield",
        state: "MA",
      }),
      composeVenueFallback({ name: longName, city: "Springfield", state: "MA" }),
      composePromoterFallback({ name: longName, city: "Springfield", state: "MA" }),
    ]) {
      expect(out.length).toBeLessThanOrEqual(160);
      expect(out).not.toMatch(/ {2,}/);
    }
  });
});
