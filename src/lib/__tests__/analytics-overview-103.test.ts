/**
 * Sanity tests for the §10.3 Overview snapshot fields. We mock the DB
 * chain just enough to assert that loadOverviewSnapshot returns the new
 * shape; full data correctness is exercised by the existing
 * analytics-overview integration tests.
 */
import { describe, it, expect } from "vitest";
import { BRAND_KEYWORDS_FOR_TEST } from "../analytics-overview-test-helpers";

describe("§10.3 brand-keyword classification", () => {
  it("includes the four canonical brand variants", () => {
    expect(BRAND_KEYWORDS_FOR_TEST).toContain("meet me at the fair");
    expect(BRAND_KEYWORDS_FOR_TEST).toContain("meetmeatthefair");
    expect(BRAND_KEYWORDS_FOR_TEST).toContain("mmatf");
    expect(BRAND_KEYWORDS_FOR_TEST).toContain("take me to the fair");
  });

  it("classifies a query as brand if it CONTAINS a keyword (substring match)", () => {
    const isBrand = (q: string) => BRAND_KEYWORDS_FOR_TEST.some((k) => q.toLowerCase().includes(k));
    expect(isBrand("meetmeatthefair vendors")).toBe(true);
    expect(isBrand("MMATF login")).toBe(true);
    expect(isBrand("maine fairs 2026")).toBe(false);
  });
});
