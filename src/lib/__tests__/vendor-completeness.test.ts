import { describe, it, expect } from "vitest";
import { computeVendorCompleteness, type VendorCompletenessInput } from "../vendor-completeness";

const FULL: VendorCompletenessInput = {
  logoUrl: "https://example.com/logo.png",
  description: "Hand-crafted goods, made locally with care.",
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

  it("description must be ≥20 chars to count", () => {
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

describe("computeVendorCompleteness — tier derivation", () => {
  it("returns ENHANCED tier when enhancedProfile=true", () => {
    const r = computeVendorCompleteness({ ...FULL, enhancedProfile: true });
    expect(r.currentTier).toBe("ENHANCED");
    expect(r.nextTier).toBeNull();
    expect(r.tierGap).toEqual([]);
    expect(r.nextTierAction).toBeNull();
  });

  it("STANDARD tier with all criteria; next tier is ENHANCED via upgrade", () => {
    const r = computeVendorCompleteness(FULL);
    expect(r.currentTier).toBe("STANDARD");
    expect(r.nextTier).toBe("ENHANCED");
    expect(r.tierGap).toEqual([]);
    expect(r.nextTierAction).toBe("upgrade_to_enhanced");
  });

  it("STUB tier (event assoc but missing description+location+signal); gap lists all 3", () => {
    const r = computeVendorCompleteness({
      ...FULL,
      description: null,
      city: null,
      state: null,
      website: null,
      socialLinks: null,
      eventAssociationCount: 1,
    });
    expect(r.currentTier).toBe("STUB");
    expect(r.nextTier).toBe("STANDARD");
    expect(r.tierGap).toEqual(["description", "city and state", "website or social link"]);
    expect(r.nextTierAction).toBe("fill_fields");
  });

  it("MENTION tier (no event assoc, no STANDARD criteria)", () => {
    const r = computeVendorCompleteness({
      ...FULL,
      description: null,
      city: null,
      state: null,
      website: null,
      socialLinks: null,
      eventAssociationCount: 0,
    });
    expect(r.currentTier).toBe("MENTION");
    expect(r.nextTier).toBe("STANDARD");
    expect(r.tierGap).toEqual(["description", "city and state", "website or social link"]);
  });

  it("STUB with description only — gap lists location + external signal", () => {
    const r = computeVendorCompleteness({
      ...FULL,
      city: null,
      state: null,
      website: null,
      socialLinks: null,
      eventAssociationCount: 2,
    });
    expect(r.currentTier).toBe("STUB");
    expect(r.tierGap).toEqual(["city and state", "website or social link"]);
  });

  it("STUB with description + location but no external signal", () => {
    const r = computeVendorCompleteness({
      ...FULL,
      website: null,
      socialLinks: null,
      eventAssociationCount: 2,
    });
    expect(r.currentTier).toBe("STUB");
    expect(r.tierGap).toEqual(["website or social link"]);
  });

  it("social_links string with content satisfies external signal", () => {
    const r = computeVendorCompleteness({
      ...FULL,
      website: null,
      socialLinks: '{"instagram":"https://instagram.com/foo"}',
    });
    expect(r.currentTier).toBe("STANDARD");
  });

  it("social_links empty object string does NOT satisfy external signal", () => {
    const r = computeVendorCompleteness({
      ...FULL,
      website: null,
      socialLinks: "{}",
      eventAssociationCount: 1,
    });
    expect(r.currentTier).toBe("STUB");
    expect(r.tierGap).toContain("website or social link");
  });
});
