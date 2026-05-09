import { describe, it, expect } from "vitest";
import { computeVendorCompleteness, type VendorCompletenessInput } from "../vendor-completeness";

const FULL: VendorCompletenessInput = {
  logoUrl: "https://example.com/logo.png",
  description: "Hand-crafted goods, made locally with care.", // 44 chars (≥30)
  products: '["Mugs","Plates"]',
  contactEmail: "vendor@example.com",
  contactPhone: null,
  city: "Boston",
  state: "MA",
  website: "https://example.com",
  socialLinks: null,
  enhancedProfile: false,
  eventAssociationCount: 3,
};

describe("computeVendorCompleteness — 5-field bar (legacy semantics preserved)", () => {
  it("100% when all 5 fields filled", () => {
    const r = computeVendorCompleteness(FULL);
    expect(r.percent).toBe(100);
    expect(r.complete).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("80% when one field missing (logo)", () => {
    const r = computeVendorCompleteness({ ...FULL, logoUrl: null });
    expect(r.percent).toBe(80);
    expect(r.missing).toEqual(["logo"]);
    expect(r.complete).toBe(false);
  });

  it("description must be ≥20 chars to count for the application bar", () => {
    const r = computeVendorCompleteness({ ...FULL, description: "short" });
    expect(r.missing).toContain("description");
  });

  it("contact info accepts email OR phone", () => {
    const r = computeVendorCompleteness({
      ...FULL,
      contactEmail: null,
      contactPhone: "555-1234",
    });
    expect(r.missing).not.toContain("contact info");
  });
});

describe("computeVendorCompleteness — tier derivation (§6.6 SEO gate)", () => {
  it("returns ENHANCED tier when enhancedProfile=true", () => {
    const r = computeVendorCompleteness({ ...FULL, enhancedProfile: true });
    expect(r.currentTier).toBe("ENHANCED");
    expect(r.nextTier).toBeNull();
    expect(r.tierGap).toEqual([]);
    expect(r.nextTierAction).toBeNull();
  });

  it("STANDARD tier with description+geo; next tier is ENHANCED via upgrade", () => {
    const r = computeVendorCompleteness(FULL);
    expect(r.currentTier).toBe("STANDARD");
    expect(r.nextTier).toBe("ENHANCED");
    expect(r.tierGap).toEqual([]);
    expect(r.nextTierAction).toBe("upgrade_to_enhanced");
  });

  it("STUB when description+location but description <30 chars", () => {
    const r = computeVendorCompleteness({
      ...FULL,
      description: "Too short to rank.", // 18 chars
      eventAssociationCount: 1,
    });
    expect(r.currentTier).toBe("STUB");
    expect(r.tierGap).toContain("description");
  });

  it("STUB tier (event assoc but no description+no geo); gap lists description+geo", () => {
    const r = computeVendorCompleteness({
      ...FULL,
      description: null,
      city: null,
      state: null,
      address: null,
      eventAssociationCount: 1,
    });
    expect(r.currentTier).toBe("STUB");
    expect(r.nextTier).toBe("STANDARD");
    expect(r.tierGap).toEqual(["description", "city and state"]);
    expect(r.nextTierAction).toBe("fill_fields");
  });

  it("MENTION tier (no event assoc, no STANDARD criteria)", () => {
    const r = computeVendorCompleteness({
      ...FULL,
      description: null,
      city: null,
      state: null,
      address: null,
      eventAssociationCount: 0,
    });
    expect(r.currentTier).toBe("MENTION");
    expect(r.nextTier).toBe("STANDARD");
    expect(r.tierGap).toEqual(["description", "city and state"]);
  });

  it("STANDARD when description ≥30 chars + geo, no website/socialLinks (external signal dropped)", () => {
    const r = computeVendorCompleteness({
      ...FULL,
      website: null,
      socialLinks: null,
      eventAssociationCount: 2,
    });
    expect(r.currentTier).toBe("STANDARD");
    expect(r.tierGap).toEqual([]);
  });

  it("STANDARD when geo comes via own address (no city/state)", () => {
    const r = computeVendorCompleteness({
      ...FULL,
      city: null,
      state: null,
      address: "100 Main St, Suite 200",
    });
    expect(r.currentTier).toBe("STANDARD");
  });

  it("STANDARD when geo comes via event-venue fallback only", () => {
    const r = computeVendorCompleteness({
      ...FULL,
      city: null,
      state: null,
      address: null,
      eventAssociationCount: 3,
      eventVenueGeoCount: 3,
    });
    expect(r.currentTier).toBe("STANDARD");
  });

  it("STUB when description ≥30 chars + event assoc but NO geo of any kind", () => {
    const r = computeVendorCompleteness({
      ...FULL,
      city: null,
      state: null,
      address: null,
      eventAssociationCount: 2,
      eventVenueGeoCount: 0,
    });
    expect(r.currentTier).toBe("STUB");
    expect(r.tierGap).toEqual(["city and state"]);
  });

  it("MENTION when domainHijacked=true regardless of other fields", () => {
    const r = computeVendorCompleteness({ ...FULL, domainHijacked: true });
    expect(r.currentTier).toBe("MENTION");
  });
});
