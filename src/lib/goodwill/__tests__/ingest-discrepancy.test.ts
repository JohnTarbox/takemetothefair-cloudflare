/**
 * Tests for compareForIngest — the GW1.1 (2026-06-03) field-comparison
 * comparator used by /api/suggest-event/check-duplicate when
 * findDuplicate returns a stages-2-4 match.
 *
 * The grid we want covered: 4 matchType × 3 fieldClass × {agree,
 * disagree}, plus the venue sub-cases for stage 4 (city/state agrees
 * but venueId differs, both differ, candidate has no venue strings,
 * etc).
 *
 * What we deliberately don't test here: the route-level wiring
 * (compareForIngest is pure — the route-side enqueue, full-event PK
 * lookup, and producer call are covered separately by route
 * integration tests as those land).
 */

import { describe, it, expect } from "vitest";
import { compareForIngest } from "../ingest-discrepancy";

const baseExisting = {
  id: "evt-existing-1",
  name: "Brattleboro Farmers Market",
  startDate: new Date("2026-06-08T00:00:00.000Z"),
  endDate: new Date("2026-06-08T00:00:00.000Z"),
  venueId: "venue-A",
  venueCity: "Brattleboro",
  venueState: "VT",
  sourceUrl: "https://brattleborofarmersmarket.com/2026",
  sourceDomain: "brattleborofarmersmarket.com",
} as const;

describe("compareForIngest — exact_url match", () => {
  it("returns no disagreements (same source by definition)", () => {
    const out = compareForIngest(
      "exact_url",
      {
        name: "totally different name",
        startDate: "2099-01-01",
        venueCity: "Boston",
        venueState: "MA",
        sourceUrl: "https://brattleborofarmersmarket.com/2026",
      },
      baseExisting
    );
    expect(out).toEqual([]);
  });
});

describe("compareForIngest — venue_date match (stage 2)", () => {
  it("emits date when start_dates differ within the ±7d window", () => {
    const out = compareForIngest(
      "venue_date",
      {
        name: "Brattleboro Farmers Market",
        startDate: "2026-06-15", // 1 week later — within window, different exact date
        sourceUrl: "https://localnews.com/markets/brattleboro",
      },
      baseExisting
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      fieldClass: "date",
      authoritativeValue: "2026-06-08",
      divergentValue: "2026-06-15",
    });
    expect(out[0].notes).toContain("venue_date");
  });

  it("emits no disagreement when start_dates agree", () => {
    const out = compareForIngest(
      "venue_date",
      {
        name: "Brattleboro Farmers Market",
        startDate: "2026-06-08",
        sourceUrl: "https://localnews.com/markets/brattleboro",
      },
      baseExisting
    );
    expect(out).toEqual([]);
  });

  it("emits name when normalized names differ (no name gate on stage 2)", () => {
    const out = compareForIngest(
      "venue_date",
      {
        name: "Saturday Farmers Festival",
        startDate: "2026-06-08",
        sourceUrl: "https://localnews.com/markets/brattleboro",
      },
      baseExisting
    );
    expect(out).toHaveLength(1);
    expect(out[0].fieldClass).toBe("name");
    expect(out[0].authoritativeValue).toBe("Brattleboro Farmers Market");
    expect(out[0].divergentValue).toBe("Saturday Farmers Festival");
  });

  it("does NOT emit venue on stage 2 (venueIds match by definition)", () => {
    const out = compareForIngest(
      "venue_date",
      {
        name: "Brattleboro Farmers Market",
        startDate: "2026-06-08",
        venueCity: "Boston", // intentionally different — should be ignored
        venueState: "MA",
        sourceUrl: "https://localnews.com/markets/brattleboro",
      },
      baseExisting
    );
    expect(out).toEqual([]);
  });
});

describe("compareForIngest — city_state_date match (stage 3)", () => {
  it("emits date when start_dates differ", () => {
    const out = compareForIngest(
      "city_state_date",
      {
        name: "Brattleboro Farmers Market",
        startDate: "2026-06-15",
        venueCity: "Brattleboro",
        venueState: "VT",
        sourceUrl: "https://localnews.com/markets/brattleboro",
      },
      baseExisting
    );
    expect(out.map((x) => x.fieldClass)).toContain("date");
  });

  it("emits venue when both sides have venueIds and they differ (Winthrop two-row case)", () => {
    const out = compareForIngest(
      "city_state_date",
      {
        name: "Brattleboro Farmers Market",
        startDate: "2026-06-08",
        venueId: "venue-B-duplicate-row",
        venueCity: "Brattleboro",
        venueState: "VT",
        sourceUrl: "https://localnews.com/markets/brattleboro",
      },
      baseExisting
    );
    const venueRow = out.find((x) => x.fieldClass === "venue");
    expect(venueRow).toBeDefined();
    expect(venueRow?.authoritativeValue).toBe("venue-A");
    expect(venueRow?.divergentValue).toBe("venue-B-duplicate-row");
  });

  it("does NOT emit venue when candidate has no resolved venueId (today's typical case)", () => {
    const out = compareForIngest(
      "city_state_date",
      {
        name: "Brattleboro Farmers Market",
        startDate: "2026-06-08",
        venueCity: "Brattleboro",
        venueState: "VT",
        sourceUrl: "https://localnews.com/markets/brattleboro",
      },
      baseExisting
    );
    expect(out.find((x) => x.fieldClass === "venue")).toBeUndefined();
  });
});

describe("compareForIngest — similar_name_date match (stage 4)", () => {
  it("does NOT emit name (names match by definition)", () => {
    const out = compareForIngest(
      "similar_name_date",
      {
        name: "Brattleboro Farmers Market 2026", // similar to existing
        startDate: "2026-06-08",
        venueCity: "Brattleboro",
        venueState: "VT",
        sourceUrl: "https://other.com/markets",
      },
      baseExisting
    );
    expect(out.find((x) => x.fieldClass === "name")).toBeUndefined();
  });

  it("emits venue when city/state differ", () => {
    const out = compareForIngest(
      "similar_name_date",
      {
        name: "Brattleboro Farmers Market 2026",
        startDate: "2026-06-08",
        venueCity: "Bennington",
        venueState: "VT",
        sourceUrl: "https://other.com/markets",
      },
      baseExisting
    );
    const venueRow = out.find((x) => x.fieldClass === "venue");
    expect(venueRow).toBeDefined();
    expect(venueRow?.authoritativeValue).toBe("Brattleboro, VT");
    expect(venueRow?.divergentValue).toBe("Bennington, VT");
  });

  it("emits date AND venue when both differ on stage 4", () => {
    const out = compareForIngest(
      "similar_name_date",
      {
        name: "Brattleboro Farmers Market 2026",
        startDate: "2026-06-15",
        venueCity: "Bennington",
        venueState: "VT",
        sourceUrl: "https://other.com/markets",
      },
      baseExisting
    );
    expect(out.map((x) => x.fieldClass).sort()).toEqual(["date", "venue"]);
  });

  it("does NOT emit venue when candidate has no venue strings (forward-compat field)", () => {
    const out = compareForIngest(
      "similar_name_date",
      {
        name: "Brattleboro Farmers Market 2026",
        startDate: "2026-06-08",
        sourceUrl: "https://other.com/markets",
      },
      baseExisting
    );
    expect(out.find((x) => x.fieldClass === "venue")).toBeUndefined();
  });
});

describe("compareForIngest — date normalization", () => {
  it("accepts YYYY-MM-DD strings without timezone shift", () => {
    // Regression: naive `new Date('2026-06-08')` parses as UTC midnight,
    // then `.toISOString().slice(0,10)` reads back as 2026-06-08. But
    // `new Date('2026-06-08T00:00:00')` parses as LOCAL midnight, which
    // may render as 2026-06-07 in negative-offset zones. The comparator
    // short-circuits the YYYY-MM-DD prefix path to avoid this.
    const out = compareForIngest(
      "venue_date",
      {
        name: "Brattleboro Farmers Market",
        startDate: "2026-06-08",
        sourceUrl: "https://localnews.com/markets/brattleboro",
      },
      baseExisting
    );
    // Same date → no disagreement → empty array.
    expect(out).toEqual([]);
  });

  it("returns empty array when candidate has no startDate (date arm guards)", () => {
    const out = compareForIngest(
      "venue_date",
      {
        name: "Brattleboro Farmers Market",
        sourceUrl: "https://localnews.com/markets/brattleboro",
      },
      baseExisting
    );
    expect(out.find((x) => x.fieldClass === "date")).toBeUndefined();
  });
});
