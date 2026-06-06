import { describe, it, expect } from "vitest";
import { monthNameToMidnightUtc } from "../utils";

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
