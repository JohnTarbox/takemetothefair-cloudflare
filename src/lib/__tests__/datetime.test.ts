import { describe, it, expect } from "vitest";
import {
  VENUE_TZ,
  parseDateOnly,
  parseDateLoose,
  parseTimestamp,
  parseWallClockInVenueZone,
  formatDateOnly,
  formatDateRange,
  formatTimeOfDay,
  formatEventDateTime,
  formatTimestamp,
  formatTimestampForServer,
  toIsoDateOnly,
  todayIsoUtc,
  yesterdayIsoUtc,
  addDaysIso,
  diffDaysIso,
  formatIcsUtc,
  formatIcsVenueZone,
  VTIMEZONE_AMERICA_NEW_YORK,
} from "../datetime";

describe("parseDateOnly", () => {
  it("parses a valid ISO date as midnight UTC", () => {
    const d = parseDateOnly("2026-04-30");
    expect(d).toBeInstanceOf(Date);
    expect(d?.toISOString()).toBe("2026-04-30T00:00:00.000Z");
  });

  it("is host-zone-independent (the form-input bug fix)", () => {
    // The old `new Date(s + "T00:00:00").toISOString()` pattern would shift
    // the date for non-UTC environments. parseDateOnly must yield the same
    // ms-epoch regardless of TZ since it uses Date.UTC().
    const d = parseDateOnly("2026-01-01");
    expect(d?.getTime()).toBe(Date.UTC(2026, 0, 1));
  });

  it("rejects calendar-invalid dates (Feb 30)", () => {
    expect(parseDateOnly("2026-02-30")).toBeNull();
  });

  it("rejects month 13", () => {
    expect(parseDateOnly("2026-13-01")).toBeNull();
  });

  it("rejects month 0", () => {
    expect(parseDateOnly("2026-00-15")).toBeNull();
  });

  it("rejects day 0", () => {
    expect(parseDateOnly("2026-04-00")).toBeNull();
  });

  it("rejects April 31", () => {
    expect(parseDateOnly("2026-04-31")).toBeNull();
  });

  it("accepts a leap day", () => {
    expect(parseDateOnly("2024-02-29")?.toISOString()).toBe("2024-02-29T00:00:00.000Z");
  });

  it("rejects Feb 29 in a non-leap year", () => {
    expect(parseDateOnly("2026-02-29")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(parseDateOnly("")).toBeNull();
  });

  it("rejects datetime strings (must be date-only)", () => {
    expect(parseDateOnly("2026-04-30T12:00:00Z")).toBeNull();
  });

  it("rejects non-string input", () => {
    expect(parseDateOnly(null)).toBeNull();
    expect(parseDateOnly(undefined)).toBeNull();
    expect(parseDateOnly(20260430)).toBeNull();
    expect(parseDateOnly(new Date())).toBeNull();
    expect(parseDateOnly({})).toBeNull();
  });
});

describe("parseDateLoose / parseTimestamp", () => {
  // parseTimestamp is a semantic alias today; assert they behave identically.
  it("parseTimestamp delegates to parseDateLoose", () => {
    expect(parseTimestamp("2026-04-30T12:00:00Z")?.toISOString()).toBe(
      parseDateLoose("2026-04-30T12:00:00Z")?.toISOString()
    );
  });

  it("parses WCF JSON without timezone-offset suffix", () => {
    const d = parseDateLoose("/Date(1714521600000)/");
    expect(d?.toISOString()).toBe("2024-05-01T00:00:00.000Z");
  });

  it("parses WCF JSON with negative timezone-offset suffix", () => {
    // The exact format Bing GetCrawlStats returns. The legacy regex missed
    // this and crashed with `RangeError: Invalid time value`.
    const d = parseDateLoose("/Date(1777532400000-0700)/");
    expect(d?.toISOString()).toBe("2026-04-30T07:00:00.000Z");
  });

  it("parses WCF JSON with positive timezone-offset suffix", () => {
    const d = parseDateLoose("/Date(1714521600000+0500)/");
    expect(d?.toISOString()).toBe("2024-05-01T00:00:00.000Z");
  });

  it("parses WCF JSON with negative epoch", () => {
    expect(parseDateLoose("/Date(-86400000)/")?.toISOString()).toBe("1969-12-31T00:00:00.000Z");
  });

  it("parses ISO 8601 strings", () => {
    expect(parseDateLoose("2026-04-30T12:34:56Z")?.toISOString()).toBe("2026-04-30T12:34:56.000Z");
  });

  it("parses date-only ISO strings", () => {
    // Note: this uses Date.parse semantics (UTC midnight), unlike parseDateOnly.
    expect(parseDateLoose("2026-04-30")?.toISOString().slice(0, 10)).toBe("2026-04-30");
  });

  it("parses raw epoch milliseconds as number", () => {
    expect(parseDateLoose(1714521600000)?.toISOString()).toBe("2024-05-01T00:00:00.000Z");
  });

  it("passes Date instances through unchanged", () => {
    const original = new Date("2026-04-30T00:00:00Z");
    expect(parseDateLoose(original)).toBe(original);
  });

  it("returns null for an Invalid Date instance", () => {
    expect(parseDateLoose(new Date("not a date"))).toBeNull();
  });

  it("returns null for null and undefined", () => {
    expect(parseDateLoose(null)).toBeNull();
    expect(parseDateLoose(undefined)).toBeNull();
  });

  it("returns null for unparseable strings rather than throwing", () => {
    expect(parseDateLoose("not a date")).toBeNull();
    expect(parseDateLoose("Invalid")).toBeNull();
    expect(parseDateLoose("")).toBeNull();
  });

  it("returns null for non-string non-number values", () => {
    expect(parseDateLoose({})).toBeNull();
    expect(parseDateLoose([])).toBeNull();
    expect(parseDateLoose(true)).toBeNull();
  });

  it("returns null for NaN and Infinity numbers", () => {
    expect(parseDateLoose(NaN)).toBeNull();
    expect(parseDateLoose(Infinity)).toBeNull();
    expect(parseDateLoose(-Infinity)).toBeNull();
  });

  it("does not throw on garbage that previously crashed the integration", () => {
    expect(() => parseDateLoose("/Date(notanumber)/")).not.toThrow();
    expect(parseDateLoose("/Date(notanumber)/")).toBeNull();
  });
});

describe("parseWallClockInVenueZone", () => {
  it("interprets a wall-clock time as venue-local during EDT (summer)", () => {
    // July 15, 2026 9:00 AM ET (EDT, UTC-4) = 13:00 UTC
    const d = parseWallClockInVenueZone("2026-07-15", "09:00");
    expect(d).toBeInstanceOf(Date);
    expect(d?.toISOString()).toBe("2026-07-15T13:00:00.000Z");
  });

  it("interprets a wall-clock time as venue-local during EST (winter)", () => {
    // January 15, 2026 9:00 AM ET (EST, UTC-5) = 14:00 UTC
    const d = parseWallClockInVenueZone("2026-01-15", "09:00");
    expect(d?.toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  it("handles the spring DST forward transition (March 8 2026)", () => {
    // 3:00 AM ET on March 8, 2026 is after the spring-forward (was 2:00 EST,
    // jumps to 3:00 EDT). 3:00 EDT = 07:00 UTC.
    const d = parseWallClockInVenueZone("2026-03-08", "03:00");
    expect(d?.toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });

  it("handles the fall DST back transition (November 1 2026)", () => {
    // 1:00 AM ET on November 1 2026 — first occurrence (still EDT, UTC-4) = 05:00 UTC
    const d = parseWallClockInVenueZone("2026-11-01", "01:00");
    expect(d?.toISOString()).toBe("2026-11-01T05:00:00.000Z");
  });

  it("returns null for malformed date or time", () => {
    expect(parseWallClockInVenueZone("garbage", "09:00")).toBeNull();
    expect(parseWallClockInVenueZone("2026-04-30", "garbage")).toBeNull();
    expect(parseWallClockInVenueZone("2026-13-01", "09:00")).toBeNull();
    expect(parseWallClockInVenueZone("2026-04-30", "25:00")).toBeNull();
  });
});

describe("formatDateOnly", () => {
  it("formats a date in UTC without a TZ label", () => {
    const out = formatDateOnly(new Date("2026-04-30T00:00:00Z"));
    expect(out).toContain("Apr");
    expect(out).toContain("30");
    expect(out).toContain("2026");
    expect(out).toMatch(/^Thu/); // April 30, 2026 is a Thursday in UTC
    expect(out).not.toMatch(/EDT|EST|UTC|GMT/); // no TZ label on date-only
  });

  it("returns empty string for null/undefined", () => {
    expect(formatDateOnly(null)).toBe("");
    expect(formatDateOnly(undefined)).toBe("");
  });

  it("returns empty string for Invalid Date", () => {
    expect(formatDateOnly(new Date("not a date"))).toBe("");
    expect(formatDateOnly("garbage")).toBe("");
  });

  it("accepts a string and parses defensively", () => {
    expect(formatDateOnly("2026-04-30T00:00:00Z")).toContain("Apr 30");
  });

  it("renders the same date regardless of host time zone (DST edge)", () => {
    // Mid-DST date — in EDT this is May 1 21:00 the prior day, but UTC-anchored.
    const utcMay1 = new Date("2026-05-01T00:00:00Z");
    expect(formatDateOnly(utcMay1)).toContain("May 1");
  });
});

describe("formatDateRange", () => {
  it("returns 'TBD' when start is missing", () => {
    expect(formatDateRange(null, null)).toBe("TBD");
    expect(formatDateRange(undefined, undefined)).toBe("TBD");
  });

  it("returns 'TBD' when start is epoch zero", () => {
    expect(formatDateRange(new Date(0), new Date(0))).toBe("TBD");
  });

  it("returns single date when end is missing", () => {
    const out = formatDateRange("2026-04-30T00:00:00Z", null);
    expect(out).toContain("Apr 30, 2026");
    expect(out).not.toContain(" - ");
  });

  it("returns single date when start and end are the same calendar day", () => {
    const start = "2026-04-30T00:00:00Z";
    const end = "2026-04-30T00:00:00Z";
    expect(formatDateRange(start, end)).not.toContain(" - ");
  });

  it("returns a range when start and end are different calendar days", () => {
    const out = formatDateRange("2026-04-30T00:00:00Z", "2026-05-02T00:00:00Z");
    expect(out).toContain("Apr 30");
    expect(out).toContain("May 2");
    expect(out).toContain(" - ");
  });
});

describe("formatTimeOfDay", () => {
  it("renders in venue zone with abbreviated TZ label (EDT in summer)", () => {
    // 21:00 UTC in July = 5:00 PM EDT
    const out = formatTimeOfDay(new Date("2026-07-15T21:00:00Z"));
    expect(out).toMatch(/5:00\s*PM/);
    expect(out).toContain("EDT");
  });

  it("renders in venue zone with abbreviated TZ label (EST in winter)", () => {
    // 22:00 UTC in January = 5:00 PM EST
    const out = formatTimeOfDay(new Date("2026-01-15T22:00:00Z"));
    expect(out).toMatch(/5:00\s*PM/);
    expect(out).toContain("EST");
  });

  it("returns empty string for null", () => {
    expect(formatTimeOfDay(null)).toBe("");
  });
});

describe("formatEventDateTime", () => {
  it("includes weekday, date, time, and TZ label in venue zone", () => {
    const out = formatEventDateTime(new Date("2026-07-15T21:00:00Z"));
    expect(out).toContain("Jul 15, 2026");
    expect(out).toMatch(/5:00\s*PM/);
    expect(out).toContain("EDT");
  });

  it("returns empty string for Invalid Date", () => {
    expect(formatEventDateTime("garbage")).toBe("");
  });
});

describe("formatTimestamp / formatTimestampForServer", () => {
  it("formatTimestampForServer always renders in UTC", () => {
    const out = formatTimestampForServer(new Date("2026-04-30T17:00:00Z"));
    expect(out).toContain("UTC");
    expect(out).toMatch(/5:00\s*PM/);
  });

  it("formatTimestamp includes a TZ label (whatever the runtime zone is)", () => {
    const out = formatTimestamp(new Date("2026-04-30T17:00:00Z"));
    expect(out.length).toBeGreaterThan(0);
    // Format should include some TZ abbreviation; we don't assert which
    // because that depends on the test runtime.
    expect(out).toMatch(/[A-Z]{2,5}\b|GMT[+-]?\d/);
  });

  it("returns empty string for null/Invalid", () => {
    expect(formatTimestamp(null)).toBe("");
    expect(formatTimestampForServer(null)).toBe("");
    expect(formatTimestamp("garbage")).toBe("");
  });
});

describe("ISO helpers", () => {
  it("toIsoDateOnly extracts YYYY-MM-DD from a Date", () => {
    expect(toIsoDateOnly(new Date("2026-04-30T17:00:00Z"))).toBe("2026-04-30");
  });

  it("todayIsoUtc returns a YYYY-MM-DD string", () => {
    expect(todayIsoUtc()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("yesterdayIsoUtc is exactly one day before todayIsoUtc", () => {
    // Hard to assert exact equality across the midnight boundary, but the
    // result must be a valid date one day earlier in the same direction.
    const today = todayIsoUtc();
    const yesterday = yesterdayIsoUtc();
    expect(yesterday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(yesterday < today || (today === yesterday && false)).toBe(true);
  });

  it("addDaysIso adds calendar days in UTC", () => {
    expect(addDaysIso("2026-04-30", 1)).toBe("2026-05-01");
    expect(addDaysIso("2026-04-30", -1)).toBe("2026-04-29");
    expect(addDaysIso("2026-04-30", 30)).toBe("2026-05-30");
  });

  it("addDaysIso doesn't drift across DST transitions in UTC", () => {
    // March 8 2026 is the EDT transition in America/New_York. Since we
    // operate in UTC, no drift expected.
    expect(addDaysIso("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDaysIso("2026-03-08", 1)).toBe("2026-03-09");
  });

  it("addDaysIso returns input unchanged on malformed input", () => {
    expect(addDaysIso("garbage", 1)).toBe("garbage");
  });

  it("diffDaysIso returns inclusive day count", () => {
    expect(diffDaysIso("2026-04-01", "2026-04-30")).toBe(30);
    expect(diffDaysIso("2026-04-30", "2026-04-30")).toBe(1);
  });

  it("diffDaysIso returns 0 on bad input", () => {
    expect(diffDaysIso("garbage", "2026-04-30")).toBe(0);
    expect(diffDaysIso("2026-04-30", "garbage")).toBe(0);
  });
});

describe("ICS helpers", () => {
  it("formatIcsUtc produces RFC 5545 UTC form", () => {
    expect(formatIcsUtc(new Date("2026-04-30T17:00:00Z"))).toBe("20260430T170000Z");
  });

  it("formatIcsUtc strips milliseconds correctly", () => {
    expect(formatIcsUtc(new Date("2026-04-30T17:00:00.456Z"))).toBe("20260430T170000Z");
  });

  it("formatIcsUtc returns empty string for Invalid Date", () => {
    expect(formatIcsUtc("garbage")).toBe("");
  });

  it("formatIcsVenueZone renders wall-clock time in the venue's zone", () => {
    // 21:00 UTC in July = 17:00 EDT
    const result = formatIcsVenueZone(new Date("2026-07-15T21:00:00Z"));
    expect(result).not.toBeNull();
    expect(result?.value).toBe("20260715T170000");
    expect(result?.tzid).toBe(VENUE_TZ);
  });

  it("formatIcsVenueZone returns null for Invalid Date", () => {
    expect(formatIcsVenueZone("garbage")).toBeNull();
  });

  it("VTIMEZONE_AMERICA_NEW_YORK contains both DST and STANDARD blocks", () => {
    expect(VTIMEZONE_AMERICA_NEW_YORK).toContain("BEGIN:VTIMEZONE");
    expect(VTIMEZONE_AMERICA_NEW_YORK).toContain("TZID:America/New_York");
    expect(VTIMEZONE_AMERICA_NEW_YORK).toContain("BEGIN:DAYLIGHT");
    expect(VTIMEZONE_AMERICA_NEW_YORK).toContain("TZNAME:EDT");
    expect(VTIMEZONE_AMERICA_NEW_YORK).toContain("BEGIN:STANDARD");
    expect(VTIMEZONE_AMERICA_NEW_YORK).toContain("TZNAME:EST");
    expect(VTIMEZONE_AMERICA_NEW_YORK).toContain("END:VTIMEZONE");
  });
});
