import { describe, it, expect } from "vitest";
import { isVendorIndexable } from "../vendor-quality";

// isVendorIndexable now delegates to the four-tier model in vendor-tier.ts.
// The binary answer = STANDARD or ENHANCED. STANDARD requires:
//   description (non-empty) AND city+state (non-empty) AND
//   (website non-empty OR has at least one social_links entry).
// ENHANCED requires enhancedProfile === true and overrides everything.

describe("isVendorIndexable — STANDARD criteria", () => {
  it("indexable when STANDARD criteria all met (description + location + website)", () => {
    expect(
      isVendorIndexable({
        description: "Hand-crafted goods",
        city: "Boston",
        state: "MA",
        website: "https://example.com",
      })
    ).toBe(true);
  });

  it("indexable when STANDARD criteria met via social_links instead of website", () => {
    expect(
      isVendorIndexable({
        description: "Hand-crafted goods",
        city: "Boston",
        state: "MA",
        socialLinks: '{"instagram":"https://instagram.com/foo"}',
      })
    ).toBe(true);
  });
});

describe("isVendorIndexable — ENHANCED override", () => {
  it("indexable when enhancedProfile=true even with no other fields", () => {
    expect(isVendorIndexable({ enhancedProfile: true })).toBe(true);
  });
});

describe("isVendorIndexable — non-indexable cases", () => {
  it("not indexable when description-only (no location, no external signal)", () => {
    // Behavioral change vs. PR #81's binary predicate: this used to be true.
    // Per §6.6 STANDARD criteria, description alone is no longer enough.
    expect(isVendorIndexable({ description: "Hand-crafted goods" })).toBe(false);
  });

  it("not indexable when website-only (no description, no location)", () => {
    expect(isVendorIndexable({ website: "https://example.com" })).toBe(false);
  });

  it("not indexable when missing location", () => {
    expect(
      isVendorIndexable({
        description: "Hand-crafted goods",
        website: "https://example.com",
      })
    ).toBe(false);
  });

  it("not indexable when missing external signal", () => {
    expect(
      isVendorIndexable({
        description: "Hand-crafted goods",
        city: "Boston",
        state: "MA",
      })
    ).toBe(false);
  });

  it("not indexable when both description and website are null", () => {
    expect(isVendorIndexable({ description: null, website: null })).toBe(false);
  });

  it("not indexable when all fields are missing", () => {
    expect(isVendorIndexable({})).toBe(false);
  });

  it("not indexable when description is whitespace-only", () => {
    expect(
      isVendorIndexable({
        description: "   ",
        city: "Boston",
        state: "MA",
        website: "https://example.com",
      })
    ).toBe(false);
  });

  it("not indexable when state is empty", () => {
    expect(
      isVendorIndexable({
        description: "Hand-crafted goods",
        city: "Boston",
        state: "",
        website: "https://example.com",
      })
    ).toBe(false);
  });

  it("not indexable when social_links is empty object", () => {
    expect(
      isVendorIndexable({
        description: "Hand-crafted goods",
        city: "Boston",
        state: "MA",
        socialLinks: "{}",
      })
    ).toBe(false);
  });
});
