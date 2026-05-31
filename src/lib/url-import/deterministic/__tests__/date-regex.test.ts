/**
 * Tests for the deterministic month-day-range date extractor.
 *
 * Canonical input comes from event-page <h1>/<h2> headings observed in
 * production: "JUNE 19-20, 2026" (moose lottery), "August 2-10, 2026"
 * (county-fair multi-day), "Sept 5–7" (chamber pages), cross-month
 * "June 28 – July 5, 2026" (multi-day spanning months).
 */

import { describe, it, expect } from "vitest";
import { findDateRange } from "../date-regex";

describe("findDateRange — same-month range", () => {
  it("parses the moose-lottery canonical 'JUNE 19-20, 2026'", () => {
    const result = findDateRange(
      "Welcome to the 2026 Maine State Moose Lottery Permit Drawing\n\nJUNE 19-20, 2026 — Acton Fairgrounds"
    );
    expect(result).toEqual({ startDate: "2026-06-19", endDate: "2026-06-20" });
  });

  it("parses a county-fair multi-day range 'August 2-10, 2026'", () => {
    expect(findDateRange("Foo County Fair August 2-10, 2026")).toEqual({
      startDate: "2026-08-02",
      endDate: "2026-08-10",
    });
  });

  it("accepts en-dash and em-dash range separators", () => {
    expect(findDateRange("Sept 5–7, 2026")).toEqual({
      startDate: "2026-09-05",
      endDate: "2026-09-07",
    });
    expect(findDateRange("Oct 1—3, 2026")).toEqual({
      startDate: "2026-10-01",
      endDate: "2026-10-03",
    });
  });

  it("accepts 'to' as a range separator", () => {
    expect(findDateRange("July 4 to 6, 2026")).toEqual({
      startDate: "2026-07-04",
      endDate: "2026-07-06",
    });
  });

  it("rejects reversed ranges (end < start in same month)", () => {
    // "May 30-25, 2026" is rejected by the d2 >= d1 check. SINGLE_DAY_RE
    // also can't anchor — "May 30" is followed by "-25" not the comma-year
    // tail it needs. Better to return null than to ship a backwards range
    // or an arbitrary half-match.
    expect(findDateRange("May 30-25, 2026")).toBeNull();
  });
});

describe("findDateRange — cross-month range", () => {
  it("parses 'June 28 - July 5, 2026'", () => {
    expect(findDateRange("Eastern States Expo June 28 - July 5, 2026")).toEqual({
      startDate: "2026-06-28",
      endDate: "2026-07-05",
    });
  });

  it("parses cross-month with en-dash 'Jul 30 – Aug 2, 2026'", () => {
    expect(findDateRange("Jul 30 – Aug 2, 2026")).toEqual({
      startDate: "2026-07-30",
      endDate: "2026-08-02",
    });
  });
});

describe("findDateRange — single-day", () => {
  it("parses 'October 3, 2026'", () => {
    expect(findDateRange("Makers Market on October 3, 2026")).toEqual({
      startDate: "2026-10-03",
      endDate: "2026-10-03",
    });
  });

  it("parses 'Aug 2 2026' (no comma)", () => {
    expect(findDateRange("Aug 2 2026")).toEqual({
      startDate: "2026-08-02",
      endDate: "2026-08-02",
    });
  });
});

describe("findDateRange — junk input", () => {
  it("returns null on empty string", () => {
    expect(findDateRange("")).toBeNull();
  });

  it("returns null when no date pattern present", () => {
    expect(findDateRange("Annual Festival — see our website for dates")).toBeNull();
  });

  it("returns null when year is missing (avoid inference)", () => {
    // "June 19-20" without a year is dropped — we'd rather ask the
    // reviewer than guess "current year".
    expect(findDateRange("June 19-20 at the fairgrounds")).toBeNull();
  });

  it("returns null for impossible dates like Feb 31", () => {
    expect(findDateRange("February 31, 2026")).toBeNull();
  });

  it("returns null for invalid months", () => {
    // The regex won't match "Smarch" because it's not in MONTH_NAMES.
    expect(findDateRange("Smarch 5, 2026")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(findDateRange("MARCH 15, 2026")).toEqual({
      startDate: "2026-03-15",
      endDate: "2026-03-15",
    });
    expect(findDateRange("march 15, 2026")).toEqual({
      startDate: "2026-03-15",
      endDate: "2026-03-15",
    });
  });
});
