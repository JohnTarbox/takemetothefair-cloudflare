import { describe, it, expect } from "vitest";
import { parseRecurrenceRule, advanceDateUTC, computeNextOccurrence } from "./recurrence";

/** Helper: a noon-UTC date for a given Y-M-D (months 1-based for readability). */
function noon(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0));
}

describe("parseRecurrenceRule", () => {
  it("parses canonical FREQ= form", () => {
    expect(parseRecurrenceRule("FREQ=YEARLY;INTERVAL=1")).toEqual({
      freq: "YEARLY",
      interval: 1,
    });
  });

  it("parses biennial INTERVAL=2", () => {
    expect(parseRecurrenceRule("FREQ=YEARLY;INTERVAL=2")).toEqual({
      freq: "YEARLY",
      interval: 2,
    });
  });

  it("tolerates the bare (FREQ-less) form", () => {
    expect(parseRecurrenceRule("YEARLY;INTERVAL=2")).toEqual({
      freq: "YEARLY",
      interval: 2,
    });
  });

  it("defaults interval to 1 when omitted", () => {
    expect(parseRecurrenceRule("MONTHLY")).toEqual({ freq: "MONTHLY", interval: 1 });
    expect(parseRecurrenceRule("FREQ=WEEKLY")).toEqual({ freq: "WEEKLY", interval: 1 });
  });

  it("is case- and whitespace-insensitive and ignores unrelated parts", () => {
    expect(parseRecurrenceRule(" freq=yearly ; interval=3 ; byday=sa,su ")).toEqual({
      freq: "YEARLY",
      interval: 3,
    });
  });

  it("returns null for empty / unknown / malformed input", () => {
    expect(parseRecurrenceRule(null)).toBeNull();
    expect(parseRecurrenceRule("")).toBeNull();
    expect(parseRecurrenceRule("FREQ=HOURLY")).toBeNull();
    expect(parseRecurrenceRule("BYDAY=SA")).toBeNull();
  });

  it("falls back to interval 1 on a non-numeric INTERVAL", () => {
    expect(parseRecurrenceRule("FREQ=YEARLY;INTERVAL=abc")).toEqual({
      freq: "YEARLY",
      interval: 1,
    });
  });
});

describe("advanceDateUTC", () => {
  it("advances one year (annual)", () => {
    expect(advanceDateUTC(noon(2026, 6, 19), "YEARLY", 1).toISOString()).toBe(
      noon(2027, 6, 19).toISOString()
    );
  });

  it("advances two years (biennial)", () => {
    expect(advanceDateUTC(noon(2025, 9, 12), "YEARLY", 2).toISOString()).toBe(
      noon(2027, 9, 12).toISOString()
    );
  });

  it("clamps a leap day Feb-29 to Feb-28 on a non-leap target year", () => {
    expect(advanceDateUTC(noon(2024, 2, 29), "YEARLY", 1).toISOString()).toBe(
      noon(2025, 2, 28).toISOString()
    );
  });

  it("clamps Jan-31 + 1 month to Feb-28 (non-leap)", () => {
    expect(advanceDateUTC(noon(2026, 1, 31), "MONTHLY", 1).toISOString()).toBe(
      noon(2026, 2, 28).toISOString()
    );
  });

  it("advances weekly across a year boundary", () => {
    // Dec-28 2026 + 1 week = Jan-04 2027
    expect(advanceDateUTC(noon(2026, 12, 28), "WEEKLY", 1).toISOString()).toBe(
      noon(2027, 1, 4).toISOString()
    );
  });

  it("advances daily", () => {
    expect(advanceDateUTC(noon(2026, 3, 30), "DAILY", 5).toISOString()).toBe(
      noon(2026, 4, 4).toISOString()
    );
  });

  it("re-anchors a midnight-UTC source to noon UTC", () => {
    const midnight = new Date(Date.UTC(2026, 5, 19, 0, 0, 0, 0));
    expect(advanceDateUTC(midnight, "YEARLY", 1).toISOString()).toBe(
      noon(2027, 6, 19).toISOString()
    );
  });
});

describe("computeNextOccurrence", () => {
  it("advances both endpoints, preserving a multi-day span", () => {
    const result = computeNextOccurrence(
      noon(2026, 10, 4),
      noon(2026, 10, 13),
      "FREQ=YEARLY;INTERVAL=1"
    );
    expect(result).not.toBeNull();
    expect(result!.start.toISOString()).toBe(noon(2027, 10, 4).toISOString());
    expect(result!.end.toISOString()).toBe(noon(2027, 10, 13).toISOString());
  });

  it("handles a Dec→Jan span advanced by one year", () => {
    const result = computeNextOccurrence(
      noon(2026, 12, 30),
      noon(2027, 1, 2),
      "FREQ=YEARLY;INTERVAL=1"
    );
    expect(result!.start.toISOString()).toBe(noon(2027, 12, 30).toISOString());
    expect(result!.end.toISOString()).toBe(noon(2028, 1, 2).toISOString());
  });

  it("returns null on unparseable rule or missing dates", () => {
    expect(computeNextOccurrence(noon(2026, 1, 1), noon(2026, 1, 2), "nonsense")).toBeNull();
    expect(computeNextOccurrence(null, noon(2026, 1, 2), "FREQ=YEARLY")).toBeNull();
    expect(computeNextOccurrence(noon(2026, 1, 1), null, "FREQ=YEARLY")).toBeNull();
  });
});
