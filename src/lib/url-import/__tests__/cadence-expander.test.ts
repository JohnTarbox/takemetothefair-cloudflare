import { describe, it, expect } from "vitest";
import { expandCadence } from "../cadence-expander";

describe("expandCadence", () => {
  it("enumerates biweekly Saturdays across the analyst's 582f3156 window", () => {
    const dates = expandCadence(
      "Artisans' Market in Unity. Every other Saturday from May 23, 2026 through December 19, 2026.",
      { windowStart: "2026-05-23", windowEnd: "2026-12-19" }
    );
    // 16 biweekly occurrences from 2026-05-23 through 2026-12-19
    expect(dates).toHaveLength(16);
    expect(dates[0]).toBe("2026-05-23");
    expect(dates[15]).toBe("2026-12-19");
    expect(dates).toEqual([
      "2026-05-23",
      "2026-06-06",
      "2026-06-20",
      "2026-07-04",
      "2026-07-18",
      "2026-08-01",
      "2026-08-15",
      "2026-08-29",
      "2026-09-12",
      "2026-09-26",
      "2026-10-10",
      "2026-10-24",
      "2026-11-07",
      "2026-11-21",
      "2026-12-05",
      "2026-12-19",
    ]);
  });

  it("handles weekly cadence", () => {
    const dates = expandCadence("Yoga every Wednesday in June.", {
      windowStart: "2026-06-01",
      windowEnd: "2026-06-30",
    });
    // Wednesdays in June 2026: 3, 10, 17, 24
    expect(dates).toEqual(["2026-06-03", "2026-06-10", "2026-06-17", "2026-06-24"]);
  });

  it("handles 'first Friday of each month'", () => {
    const dates = expandCadence("Open mic the first Friday of every month", {
      windowStart: "2026-05-01",
      windowEnd: "2026-08-31",
    });
    // First Fridays May-Aug 2026
    expect(dates).toEqual(["2026-05-01", "2026-06-05", "2026-07-03", "2026-08-07"]);
  });

  it("handles 'last Wednesday of the month'", () => {
    const dates = expandCadence("Wine tasting the last Wednesday of every month", {
      windowStart: "2026-05-01",
      windowEnd: "2026-07-31",
    });
    // Last Wednesdays May-Jul 2026
    expect(dates).toEqual(["2026-05-27", "2026-06-24", "2026-07-29"]);
  });

  it("detects explicit comma-separated date lists", () => {
    const dates = expandCadence(
      "Markets on May 23, June 6, June 20, July 4, July 18 throughout the season.",
      { windowStart: "2026-05-01", windowEnd: "2026-12-31" }
    );
    expect(dates).toContain("2026-05-23");
    expect(dates).toContain("2026-06-06");
    expect(dates).toContain("2026-06-20");
    expect(dates).toContain("2026-07-04");
    expect(dates).toContain("2026-07-18");
  });

  it("ignores isolated single dates (not a list)", () => {
    const dates = expandCadence("The annual fair returns on May 23, 2026. See you there!", {
      windowStart: "2026-01-01",
      windowEnd: "2026-12-31",
    });
    // Single date isn't a "list" — should not expand
    expect(dates).toEqual([]);
  });

  it("returns empty array for invalid windows", () => {
    expect(
      expandCadence("every Saturday", { windowStart: "bad", windowEnd: "2026-12-31" })
    ).toEqual([]);
    expect(
      expandCadence("every Saturday", { windowStart: "2026-12-31", windowEnd: "2026-01-01" })
    ).toEqual([]);
  });

  it("returns empty array when no cadence phrase present", () => {
    const dates = expandCadence("The annual fair is great. Come by anytime!", {
      windowStart: "2026-05-01",
      windowEnd: "2026-12-31",
    });
    expect(dates).toEqual([]);
  });

  it("does not confuse 'every other Saturday' with 'every Saturday'", () => {
    const biweekly = expandCadence("every other Saturday", {
      windowStart: "2026-05-23",
      windowEnd: "2026-06-30",
    });
    expect(biweekly).toEqual(["2026-05-23", "2026-06-06", "2026-06-20"]);
    const weekly = expandCadence("every Saturday", {
      windowStart: "2026-05-23",
      windowEnd: "2026-06-30",
    });
    expect(weekly).toEqual([
      "2026-05-23",
      "2026-05-30",
      "2026-06-06",
      "2026-06-13",
      "2026-06-20",
      "2026-06-27",
    ]);
  });
});
