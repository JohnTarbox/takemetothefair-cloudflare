import { describe, it, expect } from "vitest";
import {
  cadenceLabel,
  findNextUpcoming,
  inferCadence,
  isDiscontinuousWithoutDays,
} from "../recurring-display";

describe("inferCadence", () => {
  it("returns 'single' for one date", () => {
    expect(inferCadence(["2026-05-23"])).toEqual({ kind: "single" });
  });

  it("returns 'biweekly' for the Artisans' Market case (16 every-other-Saturdays)", () => {
    // The analyst's example: biweekly Saturdays from 2026-05-23 onward
    const dates = [
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
    ];
    expect(inferCadence(dates)).toEqual({ kind: "biweekly", dayOfWeek: "Saturday" });
  });

  it("returns 'weekly' for 7-day cadence on same day-of-week", () => {
    const dates = ["2026-05-04", "2026-05-11", "2026-05-18", "2026-05-25"]; // Mondays
    expect(inferCadence(dates)).toEqual({ kind: "weekly", dayOfWeek: "Monday" });
  });

  it("returns 'monthly' for same-day-of-month intervals", () => {
    const dates = ["2026-01-15", "2026-02-15", "2026-03-15"];
    expect(inferCadence(dates)).toEqual({ kind: "monthly" });
  });

  it("returns 'everyNDays' for uniform non-named intervals", () => {
    const dates = ["2026-05-01", "2026-05-04", "2026-05-07"]; // every 3 days
    expect(inferCadence(dates)).toEqual({ kind: "everyNDays", days: 3 });
  });

  it("returns 'irregular' for mixed intervals", () => {
    const dates = ["2026-05-01", "2026-05-05", "2026-05-25"]; // 4 then 20
    expect(inferCadence(dates)).toEqual({ kind: "irregular" });
  });

  it("works with unsorted input", () => {
    const dates = ["2026-05-25", "2026-05-04", "2026-05-11", "2026-05-18"];
    expect(inferCadence(dates)).toEqual({ kind: "weekly", dayOfWeek: "Monday" });
  });
});

describe("cadenceLabel", () => {
  it("returns null for single", () => {
    expect(cadenceLabel({ kind: "single" }, 1)).toBeNull();
  });

  it("formats biweekly with day name and count", () => {
    expect(cadenceLabel({ kind: "biweekly", dayOfWeek: "Saturday" }, 16)).toBe(
      "Every other Saturday — 16 dates"
    );
  });

  it("formats weekly", () => {
    expect(cadenceLabel({ kind: "weekly", dayOfWeek: "Friday" }, 8)).toBe("Every Friday — 8 dates");
  });

  it("formats monthly", () => {
    expect(cadenceLabel({ kind: "monthly" }, 12)).toBe("Monthly — 12 dates");
  });

  it("formats irregular as bare count", () => {
    expect(cadenceLabel({ kind: "irregular" }, 5)).toBe("5 dates");
  });
});

describe("findNextUpcoming", () => {
  it("returns the first date >= now", () => {
    const now = new Date("2026-06-15T12:00:00Z");
    const dates = ["2026-05-23", "2026-06-06", "2026-06-20", "2026-07-04"];
    expect(findNextUpcoming(dates, now)).toBe("2026-06-20");
  });

  it("returns null when every date is in the past", () => {
    const now = new Date("2027-01-01T12:00:00Z");
    expect(findNextUpcoming(["2026-05-23", "2026-06-06"], now)).toBeNull();
  });

  it("returns the first date when all dates are future", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const dates = ["2026-05-23", "2026-06-06"];
    expect(findNextUpcoming(dates, now)).toBe("2026-05-23");
  });
});

describe("isDiscontinuousWithoutDays", () => {
  it("flags the season-span case", () => {
    expect(isDiscontinuousWithoutDays(true, 0)).toBe(true);
  });

  it("does not flag when eventDays back the recurrence", () => {
    expect(isDiscontinuousWithoutDays(true, 16)).toBe(false);
  });

  it("does not flag a non-recurring event with no days", () => {
    expect(isDiscontinuousWithoutDays(false, 0)).toBe(false);
    expect(isDiscontinuousWithoutDays(null, 0)).toBe(false);
  });
});
