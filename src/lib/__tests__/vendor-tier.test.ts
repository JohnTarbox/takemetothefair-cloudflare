import { describe, it, expect } from "vitest";
import {
  getVendorTier,
  getSitemapPriorityTier,
  isIndexableTier,
  sitemapChangeFreqFor,
  sitemapPriorityFor,
  type VendorTier,
  type SitemapPriorityTier,
  type VendorTierFields,
} from "../vendor-tier";

// 30-char minimum description satisfies hasMeaningfulDescription.
const DESCRIPTION_30 = "Hand-crafted goods, made local.";
const DESCRIPTION_29 = "Hand-crafted goods, made loca";

const FULL_STANDARD: VendorTierFields = {
  description: DESCRIPTION_30,
  website: "https://example.com",
  socialLinks: null,
  city: "Boston",
  state: "MA",
  address: null,
  enhancedProfile: false,
  domainHijacked: false,
  eventAssociationCount: 3,
  eventVenueGeoCount: 0,
};

describe("getVendorTier — domainHijacked overrides everything", () => {
  it("MENTION when domainHijacked=true even with full STANDARD criteria", () => {
    expect(getVendorTier({ ...FULL_STANDARD, domainHijacked: true })).toBe<VendorTier>("MENTION");
  });

  it("MENTION when domainHijacked=true even with enhancedProfile=true", () => {
    expect(
      getVendorTier({ ...FULL_STANDARD, enhancedProfile: true, domainHijacked: true })
    ).toBe<VendorTier>("MENTION");
  });
});

describe("getVendorTier — ENHANCED beats STANDARD/STUB/MENTION", () => {
  it("ENHANCED when enhancedProfile=true regardless of other fields", () => {
    expect(getVendorTier({ enhancedProfile: true })).toBe<VendorTier>("ENHANCED");
    expect(getVendorTier({ ...FULL_STANDARD, enhancedProfile: true })).toBe<VendorTier>("ENHANCED");
  });

  it("ENHANCED even with no description, no location", () => {
    expect(
      getVendorTier({ enhancedProfile: true, description: null, city: null, state: null })
    ).toBe<VendorTier>("ENHANCED");
  });
});

describe("getVendorTier — STANDARD criteria (description ≥30 chars + any geo anchor)", () => {
  it("STANDARD when description ≥30 chars + own city+state", () => {
    expect(getVendorTier(FULL_STANDARD)).toBe<VendorTier>("STANDARD");
  });

  it("STANDARD via own address fallback (no city/state)", () => {
    expect(
      getVendorTier({
        ...FULL_STANDARD,
        city: null,
        state: null,
        address: "100 Main St, Suite 200",
      })
    ).toBe<VendorTier>("STANDARD");
  });

  it("STANDARD via event-venue geo fallback (no own city/state, no own address)", () => {
    expect(
      getVendorTier({
        ...FULL_STANDARD,
        city: null,
        state: null,
        address: null,
        eventVenueGeoCount: 1,
      })
    ).toBe<VendorTier>("STANDARD");
  });

  it("STANDARD without external signal (website/socialLinks no longer required)", () => {
    expect(
      getVendorTier({
        ...FULL_STANDARD,
        website: null,
        socialLinks: null,
      })
    ).toBe<VendorTier>("STANDARD");
  });

  it("not STANDARD when description is exactly 29 chars (below threshold)", () => {
    expect(getVendorTier({ ...FULL_STANDARD, description: DESCRIPTION_29 })).not.toBe<VendorTier>(
      "STANDARD"
    );
  });

  it("not STANDARD when description is null/empty/whitespace", () => {
    expect(getVendorTier({ ...FULL_STANDARD, description: null })).not.toBe<VendorTier>("STANDARD");
    expect(getVendorTier({ ...FULL_STANDARD, description: "" })).not.toBe<VendorTier>("STANDARD");
    expect(
      getVendorTier({ ...FULL_STANDARD, description: "      ".repeat(20) })
    ).not.toBe<VendorTier>("STANDARD");
  });

  it("not STANDARD when no geographic anchor at all", () => {
    expect(
      getVendorTier({
        ...FULL_STANDARD,
        city: null,
        state: null,
        address: null,
        eventVenueGeoCount: 0,
      })
    ).not.toBe<VendorTier>("STANDARD");
  });

  it("not STANDARD when city set but state missing (own-geo requires both)", () => {
    expect(
      getVendorTier({ ...FULL_STANDARD, state: null, address: null, eventVenueGeoCount: 0 })
    ).not.toBe<VendorTier>("STANDARD");
  });
});

describe("getVendorTier — STUB vs MENTION (event association)", () => {
  it("STUB when event association exists but STANDARD criteria fail", () => {
    expect(getVendorTier({ description: null, eventAssociationCount: 1 })).toBe<VendorTier>("STUB");
  });

  it("MENTION when no event association and STANDARD criteria fail", () => {
    expect(getVendorTier({ description: null, eventAssociationCount: 0 })).toBe<VendorTier>(
      "MENTION"
    );
  });

  it("MENTION when eventAssociationCount is omitted", () => {
    expect(getVendorTier({ description: null })).toBe<VendorTier>("MENTION");
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

describe("getSitemapPriorityTier — HIGH/MEDIUM/LOW classification", () => {
  it("HIGH when ENHANCED (paid tier always priority)", () => {
    expect(
      getSitemapPriorityTier({ ...FULL_STANDARD, enhancedProfile: true }, "ENHANCED")
    ).toBe<SitemapPriorityTier>("HIGH");
  });

  it("HIGH when STANDARD with own geo + ≥5 event associations", () => {
    expect(
      getSitemapPriorityTier({ ...FULL_STANDARD, eventAssociationCount: 5 }, "STANDARD")
    ).toBe<SitemapPriorityTier>("HIGH");
    expect(
      getSitemapPriorityTier({ ...FULL_STANDARD, eventAssociationCount: 12 }, "STANDARD")
    ).toBe<SitemapPriorityTier>("HIGH");
  });

  it("MEDIUM when STANDARD with own geo, <5 events", () => {
    expect(
      getSitemapPriorityTier({ ...FULL_STANDARD, eventAssociationCount: 3 }, "STANDARD")
    ).toBe<SitemapPriorityTier>("MEDIUM");
    expect(
      getSitemapPriorityTier({ ...FULL_STANDARD, eventAssociationCount: 0 }, "STANDARD")
    ).toBe<SitemapPriorityTier>("MEDIUM");
  });

  it("MEDIUM when own-address-only (no city/state)", () => {
    expect(
      getSitemapPriorityTier(
        { ...FULL_STANDARD, city: null, state: null, address: "100 Main St" },
        "STANDARD"
      )
    ).toBe<SitemapPriorityTier>("MEDIUM");
  });

  it("LOW when STANDARD via event-venue geo only", () => {
    expect(
      getSitemapPriorityTier(
        {
          ...FULL_STANDARD,
          city: null,
          state: null,
          address: null,
          eventAssociationCount: 3,
          eventVenueGeoCount: 3,
        },
        "STANDARD"
      )
    ).toBe<SitemapPriorityTier>("LOW");
  });

  it("LOW even with ≥5 events when geo is event-venue-only", () => {
    expect(
      getSitemapPriorityTier(
        {
          ...FULL_STANDARD,
          city: null,
          state: null,
          address: null,
          eventAssociationCount: 8,
          eventVenueGeoCount: 8,
        },
        "STANDARD"
      )
    ).toBe<SitemapPriorityTier>("LOW");
  });
});

describe("sitemapPriorityFor", () => {
  it("HIGH=0.8, MEDIUM=0.5, LOW=0.3", () => {
    expect(sitemapPriorityFor("HIGH")).toBe(0.8);
    expect(sitemapPriorityFor("MEDIUM")).toBe(0.5);
    expect(sitemapPriorityFor("LOW")).toBe(0.3);
  });
});

describe("sitemapChangeFreqFor", () => {
  it("HIGH=weekly, MEDIUM/LOW=monthly", () => {
    expect(sitemapChangeFreqFor("HIGH")).toBe("weekly");
    expect(sitemapChangeFreqFor("MEDIUM")).toBe("monthly");
    expect(sitemapChangeFreqFor("LOW")).toBe("monthly");
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

  it("Hijacked vendor is NOT indexable even with Enhanced", async () => {
    const { isVendorIndexable } = await import("../vendor-quality");
    expect(isVendorIndexable({ enhancedProfile: true, domainHijacked: true })).toBe(false);
  });

  it("STUB vendor (event assoc but no STANDARD criteria) is NOT indexable", async () => {
    const { isVendorIndexable } = await import("../vendor-quality");
    expect(isVendorIndexable({ description: null, eventAssociationCount: 2 })).toBe(false);
  });

  it("MENTION vendor is NOT indexable", async () => {
    const { isVendorIndexable } = await import("../vendor-quality");
    expect(isVendorIndexable({ description: null })).toBe(false);
  });

  it("description+geo without external signal is now indexable (PR §6.6 loosening)", async () => {
    const { isVendorIndexable } = await import("../vendor-quality");
    expect(
      isVendorIndexable({
        description: DESCRIPTION_30,
        city: "Boston",
        state: "MA",
        website: null,
        socialLinks: null,
      })
    ).toBe(true);
  });

  it("description-only (no geo of any kind) is NOT indexable", async () => {
    const { isVendorIndexable } = await import("../vendor-quality");
    expect(isVendorIndexable({ description: DESCRIPTION_30 })).toBe(false);
  });
});
