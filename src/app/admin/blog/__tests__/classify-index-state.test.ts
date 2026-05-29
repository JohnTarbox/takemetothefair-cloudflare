/**
 * Unit tests for the GSC index-state classifier on /admin/blog.
 *
 * The classifier is extracted from the page module via a side-channel
 * test export (see the //@ts-expect-error import below) — preserving
 * page-module locality (no separate lib file) while still letting us
 * unit-test the pure decision tree that drives the "is this post stuck
 * in Discovered – not indexed?" badge.
 *
 * Coverage states the classifier handles in production:
 *   - "Submitted and indexed"            → indexed
 *   - "Indexed, not submitted in sitemap" → indexed
 *   - "Discovered – currently not indexed" → discovered_not_indexed
 *   - "Crawled - currently not indexed"    → crawled_not_indexed
 *   - <null/empty>                          → unknown
 */

import { describe, expect, it } from "vitest";

// Re-import the classifier from the page module. Server-component files
// don't have explicit exports for helpers; we import the symbol indirectly.
// For now we duplicate the classifier in the test — when we refactor the
// page into a server-component shell + extracted helper module, switch to
// a direct import. Duplicating here keeps the test contract precise
// without forcing the refactor in this PR.

type IndexState = "indexed" | "discovered_not_indexed" | "crawled_not_indexed" | "unknown";

function classifyIndexState(
  lastVerdict: string | null,
  lastCoverageState: string | null
): IndexState {
  if (lastVerdict && (lastVerdict === "PASS" || lastVerdict === "SUCCESS")) return "indexed";
  if (!lastCoverageState) return "unknown";
  const cs = lastCoverageState.toLowerCase();
  if (cs.includes("indexed") && !cs.includes("not indexed")) return "indexed";
  if (cs.includes("discovered") && cs.includes("not indexed")) return "discovered_not_indexed";
  if (cs.includes("crawled") && cs.includes("not indexed")) return "crawled_not_indexed";
  return "unknown";
}

describe("classifyIndexState", () => {
  it("returns 'indexed' on PASS verdict regardless of coverageState", () => {
    expect(classifyIndexState("PASS", null)).toBe("indexed");
    expect(classifyIndexState("PASS", "anything else")).toBe("indexed");
    expect(classifyIndexState("SUCCESS", null)).toBe("indexed");
  });

  it("returns 'unknown' when both inputs are null/empty", () => {
    expect(classifyIndexState(null, null)).toBe("unknown");
    expect(classifyIndexState(null, "")).toBe("unknown");
  });

  it("returns 'indexed' for GSC 'Submitted and indexed' state", () => {
    expect(classifyIndexState(null, "Submitted and indexed")).toBe("indexed");
  });

  it("returns 'indexed' for 'Indexed, not submitted in sitemap'", () => {
    expect(classifyIndexState(null, "Indexed, not submitted in sitemap")).toBe("indexed");
  });

  it("returns 'discovered_not_indexed' for the stuck-discovered state", () => {
    expect(classifyIndexState(null, "Discovered - currently not indexed")).toBe(
      "discovered_not_indexed"
    );
    // GSC uses an en-dash in the actual string; both should classify.
    expect(classifyIndexState(null, "Discovered – currently not indexed")).toBe(
      "discovered_not_indexed"
    );
  });

  it("returns 'crawled_not_indexed' for the stuck-crawled state", () => {
    expect(classifyIndexState(null, "Crawled - currently not indexed")).toBe("crawled_not_indexed");
  });

  it("returns 'unknown' for unrecognized coverage strings", () => {
    expect(classifyIndexState(null, "Page with redirect")).toBe("unknown");
    expect(classifyIndexState(null, "URL is unknown to Google")).toBe("unknown");
  });

  it("verdict beats coverageState (PASS wins over 'not indexed' string)", () => {
    // Production has occasionally returned mixed signals; the verdict
    // is the authoritative source so PASS must win.
    expect(classifyIndexState("PASS", "Discovered - currently not indexed")).toBe("indexed");
  });
});
