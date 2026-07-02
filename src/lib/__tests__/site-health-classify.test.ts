import { describe, it, expect } from "vitest";
import { isExpectedNonIndexing, deriveDisplayTier } from "../site-health-classify";

describe("isExpectedNonIndexing", () => {
  it("matches the ASCII-hyphen coverage states", () => {
    expect(
      isExpectedNonIndexing("GSC_INSPECTION_NON_OK", "Discovered - currently not indexed")
    ).toBe(true);
    expect(isExpectedNonIndexing("GSC_INSPECTION_NON_OK", "Crawled - currently not indexed")).toBe(
      true
    );
  });

  it("matches the en-dash coverage states", () => {
    expect(
      isExpectedNonIndexing("GSC_INSPECTION_NON_OK", "Discovered – currently not indexed")
    ).toBe(true);
    expect(isExpectedNonIndexing("GSC_INSPECTION_NON_OK", "Crawled – currently not indexed")).toBe(
      true
    );
  });

  it("matches the em-dash coverage states too", () => {
    expect(
      isExpectedNonIndexing("GSC_INSPECTION_NON_OK", "Discovered — currently not indexed")
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      isExpectedNonIndexing("GSC_INSPECTION_NON_OK", "DISCOVERED - CURRENTLY NOT INDEXED")
    ).toBe(true);
  });

  it("matches the other expected coverage states", () => {
    expect(isExpectedNonIndexing("GSC_INSPECTION_NON_OK", "URL is unknown to Google")).toBe(true);
    expect(
      isExpectedNonIndexing("GSC_INSPECTION_NON_OK", "Alternate page with proper canonical tag")
    ).toBe(true);
    expect(
      isExpectedNonIndexing("GSC_INSPECTION_NON_OK", "Duplicate without user-selected canonical")
    ).toBe(true);
    expect(isExpectedNonIndexing("GSC_INSPECTION_NON_OK", "Page with redirect")).toBe(true);
  });

  it("never treats a rich-result failure as expected, even with coverage text", () => {
    expect(
      isExpectedNonIndexing("GSC_RICH_RESULT_FAIL", "Discovered - currently not indexed")
    ).toBe(false);
    expect(
      isExpectedNonIndexing("GSC_RICH_RESULT_FAIL", 'FAIL: Missing field "location" [Events]')
    ).toBe(false);
  });

  it("treats real defects as NOT expected", () => {
    expect(isExpectedNonIndexing("GSC_INSPECTION_NON_OK", "Submitted URL not found (404)")).toBe(
      false
    );
    expect(isExpectedNonIndexing("GSC_INSPECTION_NON_OK", "Redirect error")).toBe(false);
    expect(isExpectedNonIndexing("GSC_INSPECTION_NON_OK", "Server error (5xx)")).toBe(false);
    expect(isExpectedNonIndexing("SITEMAP_ERROR", "3 errors")).toBe(false);
  });

  it("returns false for empty/null messages", () => {
    expect(isExpectedNonIndexing("GSC_INSPECTION_NON_OK", null)).toBe(false);
    expect(isExpectedNonIndexing("GSC_INSPECTION_NON_OK", "")).toBe(false);
  });
});

describe("deriveDisplayTier", () => {
  it("returns EXPECTED for expected coverage states", () => {
    expect(
      deriveDisplayTier({
        issueType: "GSC_INSPECTION_NON_OK",
        message: "Discovered – currently not indexed",
      })
    ).toBe("EXPECTED");
  });

  it("returns ACTION for defects and rich-result failures", () => {
    expect(deriveDisplayTier({ issueType: "GSC_RICH_RESULT_FAIL", message: "FAIL: bad" })).toBe(
      "ACTION"
    );
    expect(
      deriveDisplayTier({ issueType: "GSC_INSPECTION_NON_OK", message: "Redirect error" })
    ).toBe("ACTION");
    expect(deriveDisplayTier({ issueType: "SITEMAP_PENDING", message: null })).toBe("ACTION");
  });
});
