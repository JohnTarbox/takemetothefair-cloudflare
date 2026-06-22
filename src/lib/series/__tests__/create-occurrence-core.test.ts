import { describe, it, expect } from "vitest";
import {
  inheritSeriesDefaults,
  occurrenceYearBounds,
  type SeriesRow,
} from "../create-occurrence-core";
import { differentEditionYears } from "../merge-year-guard";

const series: SeriesRow = {
  id: "s1",
  name: "Newport International Boat Show",
  venueId: "v1",
  promoterId: "p1",
  recurrenceRule: "FREQ=YEARLY",
  description: "Annual boat show",
  imageUrl: "https://img/x.jpg",
  categories: '["Boat Show"]',
  tags: '["nautical"]',
  primaryAudience: "PUBLIC",
  publicAccess: "OPEN",
};

describe("inheritSeriesDefaults", () => {
  it("inherits series defaults and applies the locked skeleton posture", () => {
    const v = inheritSeriesDefaults(series);
    expect(v).toMatchObject({
      seriesId: "s1",
      name: "Newport International Boat Show",
      venueId: "v1",
      promoterId: "p1",
      startDate: null, // skeleton — no dates unless given
      endDate: null,
      recurrenceRule: "FREQ=YEARLY",
      categories: '["Boat Show"]',
      status: "TENTATIVE",
      lifecycleStatus: "TENTATIVE",
      datesConfirmed: false,
      flaggedForReview: true,
      rolledFromEventId: null,
    });
  });

  it("applies overrides, including explicit-null venue/promoter", () => {
    const v = inheritSeriesDefaults(series, {
      name: "Special Edition",
      venueId: null,
      startDate: new Date(Date.UTC(2027, 8, 11)),
      endDate: new Date(Date.UTC(2027, 8, 14)),
    });
    expect(v.name).toBe("Special Edition");
    expect(v.venueId).toBeNull(); // explicit null wins over series default
    expect(v.promoterId).toBe("p1"); // not overridden → inherited
    expect(v.startDate).toEqual(new Date(Date.UTC(2027, 8, 11)));
  });

  it("threads the rolled_from provenance pointer (K27 absorption)", () => {
    const v = inheritSeriesDefaults(series, {}, { rolledFromEventId: "src-event" });
    expect(v.rolledFromEventId).toBe("src-event");
  });
});

describe("occurrenceYearBounds", () => {
  it("returns half-open UTC year bounds", () => {
    const { gte, lt } = occurrenceYearBounds(2027);
    expect(gte.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(lt.toISOString()).toBe("2028-01-01T00:00:00.000Z");
  });
});

describe("differentEditionYears", () => {
  it("true when both dated and years differ", () => {
    expect(
      differentEditionYears(new Date(Date.UTC(2025, 8, 1)), new Date(Date.UTC(2026, 8, 1)))
    ).toBe(true);
  });
  it("false for the same year", () => {
    expect(
      differentEditionYears(new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 11, 31)))
    ).toBe(false);
  });
  it("false when either date is missing (merge proceeds as today)", () => {
    expect(differentEditionYears(null, new Date(Date.UTC(2026, 0, 1)))).toBe(false);
    expect(differentEditionYears(new Date(Date.UTC(2026, 0, 1)), undefined)).toBe(false);
  });
});
