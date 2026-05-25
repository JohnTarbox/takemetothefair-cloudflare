import { describe, it, expect } from "vitest";
import { hasPublicFilters } from "../events-filter-count";

describe("hasPublicFilters", () => {
  it("returns false for the canonical unfiltered listing", () => {
    expect(hasPublicFilters({})).toBe(false);
  });

  it("returns false for page=1 (canonical)", () => {
    expect(hasPublicFilters({ page: "1" })).toBe(false);
  });

  it("returns true when a category filter is present", () => {
    expect(hasPublicFilters({ category: "Craft Show" })).toBe(true);
  });

  it("returns true when a state filter is present", () => {
    expect(hasPublicFilters({ state: "MAINE" })).toBe(true);
  });

  it("returns true for deep pagination (page > 1)", () => {
    // Page beyond results is one of the soft-404 cases the dev flagged.
    expect(hasPublicFilters({ page: "47" })).toBe(true);
  });

  it("returns true for boolean toggles set to 'true'", () => {
    expect(hasPublicFilters({ featured: "true" })).toBe(true);
    expect(hasPublicFilters({ commercialVendors: "true" })).toBe(true);
    expect(hasPublicFilters({ excludeFarmersMarkets: "true" })).toBe(true);
    expect(hasPublicFilters({ includePast: "true" })).toBe(true);
  });

  it("returns true for an enum filter (indoorOutdoor, scale)", () => {
    expect(hasPublicFilters({ indoorOutdoor: "INDOOR" })).toBe(true);
    expect(hasPublicFilters({ scale: "MAJOR" })).toBe(true);
  });

  it("ignores empty-string filter values (don't trigger noindex on empty form submits)", () => {
    expect(hasPublicFilters({ category: "" })).toBe(false);
    expect(hasPublicFilters({ state: "" })).toBe(false);
  });
});
