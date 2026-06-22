import { describe, it, expect } from "vitest";
import { decideDiscoveryRouting, type DiscoveryMatch } from "../discovery-routing";

const m = (over: Partial<DiscoveryMatch>): DiscoveryMatch => ({
  matched: true,
  existingSeriesId: null,
  existingYear: null,
  existingVendorBearing: false,
  existingRolledEdition: false,
  incomingYear: null,
  ...over,
});

describe("decideDiscoveryRouting", () => {
  it("no match → create_new", () => {
    expect(decideDiscoveryRouting(m({ matched: false }))).toEqual({ action: "create_new" });
  });

  it("same-year match → duplicate (a true dup, today's path)", () => {
    expect(
      decideDiscoveryRouting(m({ existingSeriesId: "s1", existingYear: 2026, incomingYear: 2026 }))
    ).toEqual({ action: "duplicate" });
  });

  it("series + different year + not vendor-bearing → occurrence", () => {
    expect(
      decideDiscoveryRouting(m({ existingSeriesId: "s1", existingYear: 2025, incomingYear: 2026 }))
    ).toEqual({ action: "occurrence", seriesId: "s1", year: 2026, warning: undefined });
  });

  it("vendor-bearing match → stage (never auto-link a roster), even with a series", () => {
    const r = decideDiscoveryRouting(
      m({
        existingSeriesId: "s1",
        existingYear: 2025,
        incomingYear: 2026,
        existingVendorBearing: true,
      })
    );
    expect(r).toMatchObject({ action: "stage", reason: "vendor-bearing" });
  });

  it("same-year takes precedence over vendor-bearing (still a duplicate)", () => {
    expect(
      decideDiscoveryRouting(
        m({
          existingSeriesId: "s1",
          existingYear: 2026,
          incomingYear: 2026,
          existingVendorBearing: true,
        })
      )
    ).toEqual({ action: "duplicate" });
  });

  it("series but an unknown year → stage year-unknown", () => {
    expect(
      decideDiscoveryRouting(m({ existingSeriesId: "s1", existingYear: null, incomingYear: 2026 }))
    ).toMatchObject({ action: "stage", reason: "year-unknown" });
  });

  it("matched event with no series → stage no-series (today's behavior)", () => {
    expect(
      decideDiscoveryRouting(m({ existingSeriesId: null, existingYear: 2025, incomingYear: 2026 }))
    ).toMatchObject({ action: "stage", reason: "no-series" });
  });

  it("surfaces a rolled-edition warning on occurrence/stage", () => {
    const r = decideDiscoveryRouting(
      m({
        existingSeriesId: "s1",
        existingYear: 2025,
        incomingYear: 2026,
        existingRolledEdition: true,
      })
    );
    expect(r).toMatchObject({ action: "occurrence", seriesId: "s1", year: 2026 });
    expect((r as { warning?: string }).warning).toMatch(/rolled skeleton/);
  });
});
