/**
 * OPE-589 — a series hub's canonical is its hero occurrence's /year page
 * (John, 2026-09-30), agreeing with the sitemap's canonicalEventPath.
 */
import { describe, it, expect } from "vitest";
import { seriesHubCanonicalPath } from "../occurrence-view";

const NOW = new Date("2026-09-30T12:00:00Z");
const occ = (start: string | null, end: string | null = start) =>
  ({
    id: start ?? "undated",
    slug: "x",
    name: "x",
    startDate: start ? new Date(start) : null,
    endDate: end ? new Date(end) : null,
  }) as never;

describe("seriesHubCanonicalPath", () => {
  it("points at the soonest UPCOMING occurrence's year (the litchfield-fair shape)", () => {
    expect(
      seriesHubCanonicalPath(
        "litchfield-fair",
        [occ("2025-09-12T12:00:00Z"), occ("2026-10-09T12:00:00Z"), occ("2027-10-08T12:00:00Z")],
        NOW
      )
    ).toBe("/events/litchfield-fair/2026");
  });

  it("with every edition past, points at the most recent one", () => {
    expect(
      seriesHubCanonicalPath(
        "x-fair",
        [occ("2024-08-01T12:00:00Z"), occ("2025-08-01T12:00:00Z")],
        NOW
      )
    ).toBe("/events/x-fair/2025");
  });

  it("stays self-canonical when there is no dated occurrence to name", () => {
    expect(seriesHubCanonicalPath("x-fair", [], NOW)).toBe("/events/x-fair");
    expect(seriesHubCanonicalPath("x-fair", [occ(null)], NOW)).toBe("/events/x-fair");
  });

  it("uses the UTC year, like the sitemap's canonicalEventPath (noon-UTC rows)", () => {
    expect(seriesHubCanonicalPath("nye", [occ("2026-12-31T12:00:00Z")], NOW)).toBe(
      "/events/nye/2026"
    );
  });
});
