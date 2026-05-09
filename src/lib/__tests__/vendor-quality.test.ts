import { describe, it, expect } from "vitest";
import { isVendorIndexable } from "../vendor-quality";

// isVendorIndexable delegates to the four-tier model in vendor-tier.ts.
// Indexable = STANDARD or ENHANCED. STANDARD requires:
//   description (≥30 chars after trim) AND any geographic anchor:
//     own city+state, OR own address, OR ≥1 event association at a
//     venue with city+state.
// ENHANCED requires enhancedProfile === true and overrides STANDARD/STUB.
// domainHijacked === true overrides everything → never indexable.

const D30 = "Hand-crafted goods, made local.";

describe("isVendorIndexable — STANDARD criteria", () => {
  it("indexable when description ≥30 chars + own city/state", () => {
    expect(
      isVendorIndexable({
        description: D30,
        city: "Boston",
        state: "MA",
      })
    ).toBe(true);
  });

  it("indexable when description ≥30 chars + own address (no city/state)", () => {
    expect(
      isVendorIndexable({
        description: D30,
        address: "100 Main St, Suite 200",
      })
    ).toBe(true);
  });

  it("indexable when description ≥30 chars + event-venue geo only", () => {
    expect(
      isVendorIndexable({
        description: D30,
        eventVenueGeoCount: 1,
      })
    ).toBe(true);
  });

  it("indexable without external signal (website/socialLinks no longer required)", () => {
    expect(
      isVendorIndexable({
        description: D30,
        city: "Boston",
        state: "MA",
        website: null,
        socialLinks: null,
      })
    ).toBe(true);
  });
});

describe("isVendorIndexable — ENHANCED override", () => {
  it("indexable when enhancedProfile=true even with no other fields", () => {
    expect(isVendorIndexable({ enhancedProfile: true })).toBe(true);
  });
});

describe("isVendorIndexable — domainHijacked override", () => {
  it("NOT indexable when domainHijacked=true regardless of other fields", () => {
    expect(
      isVendorIndexable({
        description: D30,
        city: "Boston",
        state: "MA",
        domainHijacked: true,
      })
    ).toBe(false);
  });

  it("NOT indexable when domainHijacked=true even with Enhanced", () => {
    expect(
      isVendorIndexable({
        enhancedProfile: true,
        domainHijacked: true,
      })
    ).toBe(false);
  });
});

describe("isVendorIndexable — non-indexable cases", () => {
  it("NOT indexable when description is 29 chars (just below threshold)", () => {
    expect(
      isVendorIndexable({
        description: "Hand-crafted goods, made loca", // 29 chars
        city: "Boston",
        state: "MA",
      })
    ).toBe(false);
  });

  it("NOT indexable when description-only (no geo of any kind)", () => {
    expect(isVendorIndexable({ description: D30 })).toBe(false);
  });

  it("NOT indexable when geo only (no description)", () => {
    expect(
      isVendorIndexable({
        city: "Boston",
        state: "MA",
      })
    ).toBe(false);
  });

  it("NOT indexable when state is empty string (own-geo requires both city AND state)", () => {
    expect(
      isVendorIndexable({
        description: D30,
        city: "Boston",
        state: "",
      })
    ).toBe(false);
  });

  it("NOT indexable when description is whitespace-only", () => {
    expect(
      isVendorIndexable({
        description: "   ",
        city: "Boston",
        state: "MA",
      })
    ).toBe(false);
  });

  it("NOT indexable when all fields are missing", () => {
    expect(isVendorIndexable({})).toBe(false);
  });

  it("NOT indexable when description+null + eventVenueGeoCount=0", () => {
    expect(
      isVendorIndexable({
        description: D30,
        eventVenueGeoCount: 0,
      })
    ).toBe(false);
  });
});
