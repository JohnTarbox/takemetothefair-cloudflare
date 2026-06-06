import { describe, it, expect } from "vitest";
import { monthNameToMidnightUtc, parseTimeToHHMM, parseTimeRange, expandDateRange } from "../utils";

// Pin the date-only storage convention shared across scrapers: every
// scraper-produced events.startDate / events.endDate anchors at midnight
// UTC. P3c (2026-06-06) — previously each scraper used either
// `new Date('Month Day, Year').setHours(9, …)` or
// `new Date(Date.UTC(year, month, day, 9, …))` which baked an off-convention
// time portion into the seconds-epoch.

describe("monthNameToMidnightUtc", () => {
  it("produces a Date anchored at exactly midnight UTC", () => {
    const d = monthNameToMidnightUtc("July", 15, 2026);
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe("2026-07-15T00:00:00.000Z");
    expect(d!.getUTCHours()).toBe(0);
    expect(d!.getUTCMinutes()).toBe(0);
    expect(d!.getUTCSeconds()).toBe(0);
    expect(d!.getUTCMilliseconds()).toBe(0);
  });

  it("accepts long month names (case-insensitive)", () => {
    expect(monthNameToMidnightUtc("january", 1, 2026)?.getUTCMonth()).toBe(0);
    expect(monthNameToMidnightUtc("DECEMBER", 31, 2026)?.getUTCMonth()).toBe(11);
    expect(monthNameToMidnightUtc("February", 28, 2026)?.getUTCMonth()).toBe(1);
  });

  it("accepts common abbreviations (Jan/Feb/Mar/...)", () => {
    expect(monthNameToMidnightUtc("Jan", 1, 2026)?.getUTCMonth()).toBe(0);
    expect(monthNameToMidnightUtc("Feb", 1, 2026)?.getUTCMonth()).toBe(1);
    expect(monthNameToMidnightUtc("Sep", 1, 2026)?.getUTCMonth()).toBe(8);
    expect(monthNameToMidnightUtc("Sept", 1, 2026)?.getUTCMonth()).toBe(8);
    expect(monthNameToMidnightUtc("Dec", 1, 2026)?.getUTCMonth()).toBe(11);
  });

  it("returns null for unknown month names", () => {
    expect(monthNameToMidnightUtc("Junuary", 1, 2026)).toBeNull();
    expect(monthNameToMidnightUtc("", 1, 2026)).toBeNull();
    expect(monthNameToMidnightUtc("13", 1, 2026)).toBeNull();
  });

  it("returns null for calendar-invalid dates (e.g. Feb 30)", () => {
    expect(monthNameToMidnightUtc("February", 30, 2026)).toBeNull();
    expect(monthNameToMidnightUtc("April", 31, 2026)).toBeNull();
    expect(monthNameToMidnightUtc("June", 31, 2026)).toBeNull();
  });

  it("rejects out-of-range days", () => {
    expect(monthNameToMidnightUtc("July", 0, 2026)).toBeNull();
    expect(monthNameToMidnightUtc("July", 32, 2026)).toBeNull();
    expect(monthNameToMidnightUtc("July", -1, 2026)).toBeNull();
  });

  it("rejects non-finite inputs", () => {
    expect(monthNameToMidnightUtc("July", NaN, 2026)).toBeNull();
    expect(monthNameToMidnightUtc("July", 15, NaN)).toBeNull();
    expect(monthNameToMidnightUtc("July", Infinity, 2026)).toBeNull();
  });

  it("handles leap-year Feb 29 correctly", () => {
    // 2028 is a leap year; 2026 is not.
    expect(monthNameToMidnightUtc("February", 29, 2028)?.toISOString()).toBe(
      "2028-02-29T00:00:00.000Z"
    );
    expect(monthNameToMidnightUtc("February", 29, 2026)).toBeNull();
  });
});

// ── Time-of-day helpers (event_days support) ────────────────────────

describe("parseTimeToHHMM", () => {
  it("parses 12-hour with explicit AM/PM", () => {
    expect(parseTimeToHHMM("9:00 AM")).toBe("09:00");
    expect(parseTimeToHHMM("9 AM")).toBe("09:00");
    expect(parseTimeToHHMM("9am")).toBe("09:00");
    expect(parseTimeToHHMM("9:30am")).toBe("09:30");
    expect(parseTimeToHHMM("12:00 PM")).toBe("12:00"); // noon
    expect(parseTimeToHHMM("12:00 AM")).toBe("00:00"); // midnight
    expect(parseTimeToHHMM("5:00 PM")).toBe("17:00");
    expect(parseTimeToHHMM("11:59 PM")).toBe("23:59");
  });

  it("parses 24-hour HH:MM", () => {
    expect(parseTimeToHHMM("09:00")).toBe("09:00");
    expect(parseTimeToHHMM("21:30")).toBe("21:30");
    expect(parseTimeToHHMM("00:00")).toBe("00:00");
    expect(parseTimeToHHMM("23:59")).toBe("23:59");
  });

  it("returns null for ambiguous input (no AM/PM and not HH:MM)", () => {
    expect(parseTimeToHHMM("9")).toBeNull();
    expect(parseTimeToHHMM("9-5")).toBeNull();
    expect(parseTimeToHHMM("9 to 5")).toBeNull();
  });

  it("returns null for out-of-range hours", () => {
    expect(parseTimeToHHMM("25:00")).toBeNull();
    expect(parseTimeToHHMM("13 PM")).toBeNull(); // 12h max is 12
    expect(parseTimeToHHMM("0 AM")).toBeNull(); // 12h min is 1
  });

  it("returns null for invalid minutes", () => {
    expect(parseTimeToHHMM("9:60 AM")).toBeNull();
    expect(parseTimeToHHMM("9:99 PM")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(parseTimeToHHMM(null)).toBeNull();
    expect(parseTimeToHHMM(undefined)).toBeNull();
    expect(parseTimeToHHMM(900)).toBeNull();
    expect(parseTimeToHHMM("")).toBeNull();
    expect(parseTimeToHHMM("foo bar")).toBeNull();
  });
});

describe("parseTimeRange", () => {
  it("parses range with AM/PM on both sides", () => {
    expect(parseTimeRange("9:00 AM - 5:00 PM")).toEqual({
      openTime: "09:00",
      closeTime: "17:00",
    });
    expect(parseTimeRange("9am-5pm")).toEqual({ openTime: "09:00", closeTime: "17:00" });
  });

  it("parses 24-hour ranges", () => {
    expect(parseTimeRange("10:00 - 18:00")).toEqual({
      openTime: "10:00",
      closeTime: "18:00",
    });
  });

  it("inherits AM/PM from end side when only end is marked", () => {
    // "9-5pm" → 9 AM (start) to 5 PM (end). Common abbreviation.
    expect(parseTimeRange("9-5pm")).toEqual({ openTime: "09:00", closeTime: "17:00" });
    // "10-2pm" → 10 AM to 2 PM
    expect(parseTimeRange("10-2pm")).toEqual({ openTime: "10:00", closeTime: "14:00" });
    // "2-9pm" → 2 PM to 9 PM (both PM, start < end so PM is correct)
    expect(parseTimeRange("2-9pm")).toEqual({ openTime: "14:00", closeTime: "21:00" });
  });

  it("handles real source-page patterns: February 7 @ 2:00 PM - 7:00 PM", () => {
    // The exact pattern that triggered #358 and this PR.
    expect(parseTimeRange("February 7 @ 2:00 PM - 7:00 PM")).toEqual({
      openTime: "14:00",
      closeTime: "19:00",
    });
  });

  it("handles en-dash and em-dash separators", () => {
    expect(parseTimeRange("9:00 AM – 5:00 PM")).toEqual({
      openTime: "09:00",
      closeTime: "17:00",
    });
    expect(parseTimeRange("9:00 AM — 5:00 PM")).toEqual({
      openTime: "09:00",
      closeTime: "17:00",
    });
  });

  it("returns null when no range is present", () => {
    expect(parseTimeRange("9:00 AM")).toBeNull();
    expect(parseTimeRange("foo bar")).toBeNull();
    expect(parseTimeRange("")).toBeNull();
  });

  it("returns null when both sides are ambiguous", () => {
    // No AM/PM anywhere, not 24-hour HH:MM — too ambiguous to guess.
    expect(parseTimeRange("9-5")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(parseTimeRange(null)).toBeNull();
    expect(parseTimeRange(undefined)).toBeNull();
    expect(parseTimeRange(123)).toBeNull();
  });
});

describe("expandDateRange", () => {
  it("returns single date when start == end", () => {
    const d = new Date(Date.UTC(2026, 1, 7));
    expect(expandDateRange(d, d)).toEqual(["2026-02-07"]);
  });

  it("returns N dates for a multi-day range, inclusive both ends", () => {
    const start = new Date(Date.UTC(2026, 6, 15)); // 2026-07-15
    const end = new Date(Date.UTC(2026, 6, 18)); // 2026-07-18
    expect(expandDateRange(start, end)).toEqual([
      "2026-07-15",
      "2026-07-16",
      "2026-07-17",
      "2026-07-18",
    ]);
  });

  it("handles month boundary", () => {
    const start = new Date(Date.UTC(2026, 6, 30));
    const end = new Date(Date.UTC(2026, 7, 2));
    expect(expandDateRange(start, end)).toEqual([
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ]);
  });

  it("handles year boundary", () => {
    const start = new Date(Date.UTC(2026, 11, 30));
    const end = new Date(Date.UTC(2027, 0, 2));
    expect(expandDateRange(start, end)).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
  });

  it("returns empty array for end < start", () => {
    const start = new Date(Date.UTC(2026, 6, 18));
    const end = new Date(Date.UTC(2026, 6, 15));
    expect(expandDateRange(start, end)).toEqual([]);
  });

  it("returns empty array for invalid Dates", () => {
    expect(expandDateRange(new Date("garbage"), new Date(Date.UTC(2026, 6, 18)))).toEqual([]);
    expect(expandDateRange(new Date(Date.UTC(2026, 6, 18)), new Date("garbage"))).toEqual([]);
  });
});
