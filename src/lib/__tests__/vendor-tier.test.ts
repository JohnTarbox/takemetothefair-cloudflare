import { describe, it, expect } from "vitest";
import {
  getVendorTier,
  isIndexableTier,
  sitemapChangeFreqFor,
  sitemapPriorityFor,
  type VendorTier,
  type VendorTierFields,
} from "../vendor-tier";

const FULL_STANDARD: VendorTierFields = {
  description: "Hand-crafted goods, made locally.",
  website: "https://example.com",
  socialLinks: null,
  city: "Boston",
  state: "MA",
  enhancedProfile: false,
  eventAssociationCount: 3,
};

describe("getVendorTier — ENHANCED beats everything", () => {
  it("ENHANCED when enhancedProfile=true regardless of other fields", () => {
    expect(getVendorTier({ enhancedProfile: true })).toBe<VendorTier>("ENHANCED");
    expect(getVendorTier({ ...FULL_STANDARD, enhancedProfile: true })).toBe<VendorTier>("ENHANCED");
  });

  it("ENHANCED even with no description, no location, no website", () => {
    expect(
      getVendorTier({ enhancedProfile: true, description: null, city: null, state: null })
    ).toBe<VendorTier>("ENHANCED");
  });
});

describe("getVendorTier — STANDARD criteria (description + own location + external signal)", () => {
  it("STANDARD when all three criteria met via website", () => {
    expect(getVendorTier(FULL_STANDARD)).toBe<VendorTier>("STANDARD");
  });

  it("STANDARD when external signal is social_links instead of website", () => {
    expect(
      getVendorTier({
        ...FULL_STANDARD,
        website: null,
        socialLinks: '{"facebook":"https://facebook.com/foo"}',
      })
    ).toBe<VendorTier>("STANDARD");
  });

  it("STANDARD when social_links is an object (already parsed)", () => {
    expect(
      getVendorTier({
        ...FULL_STANDARD,
        website: null,
        socialLinks: { instagram: "https://instagram.com/foo" },
      })
    ).toBe<VendorTier>("STANDARD");
  });

  it("not STANDARD when description is empty", () => {
    expect(getVendorTier({ ...FULL_STANDARD, description: "" })).not.toBe<VendorTier>("STANDARD");
  });

  it("not STANDARD when description is whitespace-only", () => {
    expect(getVendorTier({ ...FULL_STANDARD, description: "   " })).not.toBe<VendorTier>(
      "STANDARD"
    );
  });

  it("not STANDARD when city is missing", () => {
    expect(getVendorTier({ ...FULL_STANDARD, city: null })).not.toBe<VendorTier>("STANDARD");
  });

  it("not STANDARD when state is missing", () => {
    expect(getVendorTier({ ...FULL_STANDARD, state: null })).not.toBe<VendorTier>("STANDARD");
  });

  it("not STANDARD when no website AND no social_links", () => {
    expect(
      getVendorTier({ ...FULL_STANDARD, website: null, socialLinks: null })
    ).not.toBe<VendorTier>("STANDARD");
  });

  it("not STANDARD when social_links is empty object string", () => {
    expect(
      getVendorTier({ ...FULL_STANDARD, website: null, socialLinks: "{}" })
    ).not.toBe<VendorTier>("STANDARD");
  });

  it("not STANDARD when social_links is malformed JSON", () => {
    expect(
      getVendorTier({ ...FULL_STANDARD, website: null, socialLinks: "{not json" })
    ).not.toBe<VendorTier>("STANDARD");
  });
});

describe("getVendorTier — STUB vs MENTION (event association)", () => {
  it("STUB when event association exists but STANDARD criteria fail", () => {
    expect(
      getVendorTier({ description: null, website: null, eventAssociationCount: 1 })
    ).toBe<VendorTier>("STUB");
  });

  it("MENTION when no event association and STANDARD criteria fail", () => {
    expect(
      getVendorTier({ description: null, website: null, eventAssociationCount: 0 })
    ).toBe<VendorTier>("MENTION");
  });

  it("MENTION when eventAssociationCount is omitted", () => {
    expect(getVendorTier({ description: null, website: null })).toBe<VendorTier>("MENTION");
  });

  it("STUB when partial signals present but not enough for STANDARD (description only)", () => {
    expect(
      getVendorTier({
        description: "Some description",
        city: null,
        state: null,
        website: null,
        eventAssociationCount: 5,
      })
    ).toBe<VendorTier>("STUB");
  });
});

describe("isIndexableTier", () => {
  it("STANDARD and ENHANCED are indexable", () => {
    expect(isIndexableTier("STANDARD")).toBe(true);
    expect(isIndexableTier("ENHANCED")).toBe(true);
  });

  it("STUB and MENTION are NOT indexable", () => {
    expect(isIndexableTier("STUB")).toBe(false);
    expect(isIndexableTier("MENTION")).toBe(false);
  });
});

describe("sitemapPriorityFor", () => {
  it("ENHANCED is 0.8, STANDARD is 0.5", () => {
    expect(sitemapPriorityFor("ENHANCED")).toBe(0.8);
    expect(sitemapPriorityFor("STANDARD")).toBe(0.5);
  });

  it("STUB and MENTION return 0 (caller should filter first)", () => {
    expect(sitemapPriorityFor("STUB")).toBe(0);
    expect(sitemapPriorityFor("MENTION")).toBe(0);
  });
});

describe("sitemapChangeFreqFor", () => {
  it("ENHANCED is weekly, STANDARD is monthly", () => {
    expect(sitemapChangeFreqFor("ENHANCED")).toBe("weekly");
    expect(sitemapChangeFreqFor("STANDARD")).toBe("monthly");
  });

  it("STUB and MENTION return never", () => {
    expect(sitemapChangeFreqFor("STUB")).toBe("never");
    expect(sitemapChangeFreqFor("MENTION")).toBe("never");
  });
});

describe("isVendorIndexable (delegation through vendor-quality)", () => {
  it("STANDARD vendor is indexable via the binary helper", async () => {
    const { isVendorIndexable } = await import("../vendor-quality");
    expect(isVendorIndexable(FULL_STANDARD)).toBe(true);
  });

  it("ENHANCED vendor is indexable", async () => {
    const { isVendorIndexable } = await import("../vendor-quality");
    expect(isVendorIndexable({ enhancedProfile: true })).toBe(true);
  });

  it("STUB vendor (event assoc but no STANDARD criteria) is NOT indexable", async () => {
    const { isVendorIndexable } = await import("../vendor-quality");
    expect(isVendorIndexable({ description: null, website: null, eventAssociationCount: 2 })).toBe(
      false
    );
  });

  it("MENTION vendor is NOT indexable", async () => {
    const { isVendorIndexable } = await import("../vendor-quality");
    expect(isVendorIndexable({ description: null, website: null })).toBe(false);
  });

  it("backward-compat: vendor with description-only is now NOT indexable (was true under PR #81 binary, now requires location too)", async () => {
    // This is the key behavioral shift. PR #81's predicate was OR; the tier
    // model requires AND across description+location+external signal. Vendors
    // with only a description but no location/external signal demote from
    // indexable to non-indexable. This is intentional per §6.6 STANDARD.
    const { isVendorIndexable } = await import("../vendor-quality");
    expect(isVendorIndexable({ description: "Just a description, no other fields" })).toBe(false);
  });
});
