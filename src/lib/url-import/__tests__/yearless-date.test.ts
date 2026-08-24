/**
 * OPE-531 — a month-day with no year must reach `start_date`.
 *
 * Live specimen: inbound `a0e400a9-89ff-4c08-8c22-172d90e8b286` ("VCS Makers
 * Market", 2026-08-23) produced event `c8648f70` with `start_date NULL` from a
 * body that states the date three times — and never once states a year.
 *
 * NOTE ON WHAT THIS FILE IMPORTS. `sanitizers.test.ts` re-implements
 * `sanitizeDate` locally ("since they're not exported"), so its ~50 assertions
 * pin a COPY and would stay green against any change to the shipped function.
 * These tests import the real one. That is the point of the file as much as
 * the yearless case is.
 */

import { describe, it, expect } from "vitest";
import { sanitizeDate, resolveYearlessDate } from "../ai-extractor";

// 2026-08-24T00:00:00Z — the day after the specimen landed.
const AUG_24_2026 = Date.UTC(2026, 7, 24);

describe("resolveYearlessDate", () => {
  it("resolves the specimen's date, in every form the body prints it", () => {
    // "Mark your calendar for the VCS Makers Market on Saturday, September
    // 12th" / "September 12 | 10 AM-3 PM" / "SEPTEMBER 12TH".
    expect(resolveYearlessDate("September 12", AUG_24_2026)).toBe("2026-09-12");
    expect(resolveYearlessDate("September 12th", AUG_24_2026)).toBe("2026-09-12");
    expect(resolveYearlessDate("Saturday, September 12th", AUG_24_2026)).toBe("2026-09-12");
    expect(resolveYearlessDate("SEPTEMBER 12TH", AUG_24_2026)).toBe("2026-09-12");
    expect(resolveYearlessDate("Sat, Sept 12", AUG_24_2026)).toBe("2026-09-12");
    expect(resolveYearlessDate("12 September", AUG_24_2026)).toBe("2026-09-12");
  });

  it("strips a leading weekday whose full name shares a prefix with its abbreviation", () => {
    // Regression on my own first draft: ordered alternation let `tue` win
    // against "Tuesday" and stranded "sday".
    expect(resolveYearlessDate("Tuesday, December 1", AUG_24_2026)).toBe("2026-12-01");
    expect(resolveYearlessDate("Wednesday, December 2", AUG_24_2026)).toBe("2026-12-02");
    expect(resolveYearlessDate("Thursday, December 3", AUG_24_2026)).toBe("2026-12-03");
  });

  it("picks the NEXT occurrence rather than the current year", () => {
    // The whole reason for next-occurrence: current-year would yield a PAST
    // date, which date-grounding.ts then grades `fabricated` and drops — the
    // same null by a longer road, and its documented worst failure mode.
    expect(resolveYearlessDate("January 10", Date.UTC(2026, 11, 20))).toBe("2027-01-10");
    expect(resolveYearlessDate("August 23", AUG_24_2026)).toBe("2027-08-23");
  });

  it("treats today as still upcoming", () => {
    // An event later TODAY must not be pushed a year out.
    expect(resolveYearlessDate("August 24", AUG_24_2026)).toBe("2026-08-24");
  });

  it("skips forward to a year in which the day actually exists", () => {
    // 2026 and 2027 are not leap years; 2028 is.
    expect(resolveYearlessDate("February 29", AUG_24_2026)).toBe("2028-02-29");
  });

  it("refuses a day the month does not have, rather than rolling into the next month", () => {
    // Date.UTC(y, 1, 30) silently becomes 2 March — the round-trip check is
    // what stops that becoming a real stored date.
    expect(resolveYearlessDate("February 30", AUG_24_2026)).toBeNull();
    expect(resolveYearlessDate("April 31", AUG_24_2026)).toBeNull();
    expect(resolveYearlessDate("June 0", AUG_24_2026)).toBeNull();
  });

  it("refuses anything that is not a month and a day", () => {
    expect(resolveYearlessDate("Someday 12", AUG_24_2026)).toBeNull();
    expect(resolveYearlessDate("September", AUG_24_2026)).toBeNull();
    expect(resolveYearlessDate("12", AUG_24_2026)).toBeNull();
    expect(resolveYearlessDate("later this year", AUG_24_2026)).toBeNull();
    expect(resolveYearlessDate("", AUG_24_2026)).toBeNull();
  });
});

describe("sanitizeDate — yearless input reaches a real date", () => {
  it("no longer drops the specimen silently", () => {
    // Before OPE-531 both of these returned null: "September 12th" is an
    // Invalid Date, and "September 12" parses to year 2001, which the
    // `year >= 2020` guard discards.
    expect(sanitizeDate("Saturday, September 12th", AUG_24_2026)).toBe("2026-09-12");
    expect(sanitizeDate("September 12", AUG_24_2026)).toBe("2026-09-12");
  });

  it("does NOT invent a date where the source states none — the OPE-465 direction", () => {
    // The failure this fix must not trade for the one it removes. "details
    // will be sent out later this year" is the UMF specimen (OPE-463).
    expect(sanitizeDate(null, AUG_24_2026)).toBeNull();
    expect(sanitizeDate("", AUG_24_2026)).toBeNull();
    expect(sanitizeDate("TBD", AUG_24_2026)).toBeNull();
    expect(sanitizeDate("null", AUG_24_2026)).toBeNull();
    expect(sanitizeDate("details will be sent out later this year", AUG_24_2026)).toBeNull();
  });

  it("PINS A KNOWN GAP: an underspecified date still fabricates a day-of-month", () => {
    // NOT endorsed behaviour — pinned so that fixing it is a deliberate act
    // with a failing test, rather than a silent change.
    //
    // Found by this file, pre-existing, and NOT introduced by the yearless
    // branch (which requires a 1-2 digit day, so it never sees these). The
    // culprit is the native-`Date` fallback below it: `new Date("Fall 2026")`
    // is 1 January and `new Date("March 2026")` is 1 March. A season and a
    // bare month are not days, and inventing the 1st is the OPE-465
    // fabrication direction — the same class as the Martha's Vineyard 2024
    // row that OPE-432 was filed for.
    //
    // Left alone deliberately: narrowing the native fallback reaches every
    // extraction path, which is wider than OPE-531's scope. Reported on the
    // ticket for its own change.
    expect(sanitizeDate("Fall 2026", AUG_24_2026)).toBe("2026-01-01");
    expect(sanitizeDate("March 2026", AUG_24_2026)).toBe("2026-03-01");
  });

  it("leaves an explicit year exactly as it was — these are the controls", () => {
    // If the yearless branch ever shadowed these, the fix would be worse than
    // the defect. They must pass with the branch in AND with it neutered.
    expect(sanitizeDate("2025-03-15", AUG_24_2026)).toBe("2025-03-15");
    expect(sanitizeDate("September 12, 2026", AUG_24_2026)).toBe("2026-09-12");
    expect(sanitizeDate("January 15, 2025", AUG_24_2026)).toBe("2025-01-15");
    expect(sanitizeDate("15 January 2025", AUG_24_2026)).toBe("2025-01-15");
    expect(sanitizeDate("03/15/2025", AUG_24_2026)).toBe("2025-03-15");
    expect(sanitizeDate("3/5/2025", AUG_24_2026)).toBe("2025-03-05");
    // Explicit Z: the existing ISO branch round-trips through `toISOString()`,
    // so a naive local-time literal here would assert a different string in
    // CI (UTC) than on a developer machine.
    expect(sanitizeDate("2025-03-15T10:30:00Z", AUG_24_2026)).toBe("2025-03-15T10:30:00");
  });
});
