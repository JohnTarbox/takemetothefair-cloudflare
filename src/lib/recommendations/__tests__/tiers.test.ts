import { describe, it, expect } from "vitest";
import { tierFor, opportunityScore, TIER_META } from "../tiers";

describe("§10.3 tier classification", () => {
  it("maps T1 revenue rules", () => {
    expect(tierFor("enhanced_profile_cohort")).toBe("T1");
    expect(tierFor("standards_eligible_for_claim_outreach")).toBe("T1");
    expect(tierFor("claimed_ready_for_enhanced_upsell")).toBe("T1");
    expect(tierFor("enhanced_profile_renewals")).toBe("T1");
  });

  it("maps T2 SEO defense rules", () => {
    expect(tierFor("hijacked_domain_detection")).toBe("T2");
    expect(tierFor("competitor_url_contamination")).toBe("T2");
    expect(tierFor("cannibalization_detection")).toBe("T2");
  });

  it("maps T3 content quality rules", () => {
    expect(tierFor("vendors_no_description")).toBe("T3");
    expect(tierFor("vendors_short_description")).toBe("T3");
    expect(tierFor("stubs_ready_for_enrichment")).toBe("T3");
  });

  it("defaults unknown rules to T3", () => {
    expect(tierFor("brand_new_unknown_rule")).toBe("T3");
  });

  it("TIER_META has all three tiers", () => {
    expect(TIER_META.T1.label).toContain("Tier 1");
    expect(TIER_META.T2.label).toContain("Tier 2");
    expect(TIER_META.T3.label).toContain("Tier 3");
    expect(TIER_META.T1.sortOrder).toBeLessThan(TIER_META.T2.sortOrder);
    expect(TIER_META.T2.sortOrder).toBeLessThan(TIER_META.T3.sortOrder);
  });
});

describe("opportunityScore", () => {
  it("ranks high-severity above lower regardless of count", () => {
    expect(opportunityScore("red", 1)).toBeGreaterThan(opportunityScore("yellow", 99));
    expect(opportunityScore("yellow", 1)).toBeGreaterThan(opportunityScore("blue", 99));
  });

  it("uses match count as tiebreaker within same severity", () => {
    expect(opportunityScore("red", 5)).toBeGreaterThan(opportunityScore("red", 1));
    expect(opportunityScore("yellow", 50)).toBeGreaterThan(opportunityScore("yellow", 10));
  });

  it("clamps match count at 99 (so a single huge rule doesn't dominate)", () => {
    expect(opportunityScore("blue", 100)).toBe(opportunityScore("blue", 99));
    expect(opportunityScore("blue", 1000)).toBe(opportunityScore("blue", 99));
  });
});
