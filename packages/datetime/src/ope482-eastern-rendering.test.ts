/**
 * OPE-482 — date-only rendering moved from UTC to America/New_York.
 *
 * The ticket's acceptance asks for "a fixture at each of 03:59:59Z, 00:00:00Z,
 * 12:00:00Z, and 01:00:00Z, asserted in both EDT and EST". That is what the
 * first block does, and the fixtures are not invented — each is a storage
 * convention measured in production on 2026-08-25:
 *
 *   12:00:00Z   987 rows   the canonical anchor
 *   03:59:59Z    15 rows   23:59:59 Eastern, end of the last day
 *   00:00:00Z    20 rows   midnight UTC, "this calendar date" literally
 *   01:00:00Z     6 rows   a real Eastern closing time (9pm)
 *   04:00:00Z     2 rows   midnight Eastern — only mismatches in the EST half
 *
 * The DST pair matters on its own: 04:00:00Z is the one convention whose
 * correctness DEPENDS on the season, so a suite that only tested summer would
 * pass while the winter half was wrong.
 */
import { describe, it, expect } from "vitest";
import {
  formatDateOnly,
  formatDateRange,
  formatDateMedium,
  toIsoDateOnly,
  toIsoDateOnlyInVenueZone,
  getVenueZoneYear,
} from "./index";

/** The Eastern calendar date a stored instant renders as. */
const shown = (iso: string) => toIsoDateOnlyInVenueZone(new Date(iso));

describe("EDT (summer) — every convention renders its intended Eastern day", () => {
  const cases: Array<[string, string, string]> = [
    // stored instant                intended ET day   why
    ["2026-09-27T03:59:59.000Z", "2026-09-26", "Class A — 23:59:59 ET, end of the last day"],
    ["2026-09-20T12:00:00.000Z", "2026-09-20", "canonical noon anchor"],
    ["2026-09-14T01:00:00.000Z", "2026-09-13", "Class C — a real 9pm ET close"],
    ["2026-09-20T04:00:00.000Z", "2026-09-20", "Class D — midnight ET, EDT half"],
  ];
  for (const [stored, expected, why] of cases) {
    it(`${stored} → ${expected} (${why})`, () => {
      expect(shown(stored)).toBe(expected);
    });
  }

  it("the live specimen from the ticket: farmington-fair ends Sep 26, not Sep 27", () => {
    // end_date = 1790481599 exactly, as stored in production.
    const end = new Date(1790481599 * 1000);
    expect(end.toISOString()).toBe("2026-09-27T03:59:59.000Z"); // pins the fixture
    expect(formatDateOnly(end)).toBe("Sat, Sep 26, 2026");
    expect(formatDateRange(new Date("2026-09-20T12:00:00Z"), end)).toBe(
      "Sun, Sep 20, 2026 - Sat, Sep 26, 2026"
    );
  });
});

describe("EST (winter) — the season is load-bearing, not incidental", () => {
  it("04:00:00Z is midnight ET in summer but 11pm the PREVIOUS day in winter", () => {
    // The same wall-clock convention, six months apart, is a different calendar
    // day. This is why the repro query in the ticket needs real DST bounds and a
    // hardcoded '-4 hours' misses Class D entirely.
    expect(shown("2026-07-15T04:00:00.000Z")).toBe("2026-07-15");
    expect(shown("2026-01-15T04:00:00.000Z")).toBe("2026-01-14");
  });

  it("03:59:59Z still resolves to the previous Eastern day under EST", () => {
    expect(shown("2026-01-15T03:59:59.000Z")).toBe("2026-01-14");
  });

  it("the noon anchor is season-independent — the whole reason it is the anchor", () => {
    expect(shown("2026-01-15T12:00:00.000Z")).toBe("2026-01-15");
    expect(shown("2026-07-15T12:00:00.000Z")).toBe("2026-07-15");
    // and it agrees with the UTC reading in both seasons, which 00:00:00Z does not
    expect(toIsoDateOnly(new Date("2026-01-15T12:00:00Z"))).toBe(shown("2026-01-15T12:00:00.000Z"));
    expect(toIsoDateOnly(new Date("2026-07-15T12:00:00Z"))).toBe(shown("2026-07-15T12:00:00.000Z"));
  });
});

describe("the trap: midnight UTC is the ONE convention Eastern rendering breaks", () => {
  it("00:00:00Z renders one day EARLY — which is why drizzle/0232 re-anchors it", () => {
    // south-boston-st-patricks-day-parade-2026, stored 2026-03-15T00:00:00Z, is a
    // real Sunday-March-15 parade. Left alone it would start displaying March 14.
    expect(shown("2026-03-15T00:00:00.000Z")).toBe("2026-03-14");
  });

  it("after the noon re-anchor the same row renders correctly", () => {
    expect(shown("2026-03-15T12:00:00.000Z")).toBe("2026-03-15");
  });
});

describe("bare YYYY-MM-DD strings are calendar dates, not instants", () => {
  // event_days.date and every form input are strings. Routing them through
  // parseDateOnly (midnight UTC) and then an Eastern formatter is the same
  // day-early defect one level down, so the formatters anchor them at noon.
  it("renders the day it says, not the day before", () => {
    expect(formatDateOnly("2026-09-20")).toBe("Sun, Sep 20, 2026");
    expect(formatDateMedium("2026-03-15")).toBe("Mar 15, 2026");
  });

  it("holds across the DST boundary in both directions", () => {
    expect(formatDateOnly("2026-01-15")).toBe("Thu, Jan 15, 2026");
    expect(formatDateOnly("2026-07-15")).toBe("Wed, Jul 15, 2026");
    // The spring-forward and fall-back days themselves.
    expect(formatDateOnly("2026-03-08")).toBe("Sun, Mar 8, 2026");
    expect(formatDateOnly("2026-11-01")).toBe("Sun, Nov 1, 2026");
  });

  it("a calendar-invalid string is still rejected", () => {
    expect(formatDateOnly("2026-02-30")).toBe("");
    expect(formatDateOnly("2026-13-01")).toBe("");
  });
});

describe("formatDateRange compares calendar days in the zone it renders in", () => {
  it("a same-Eastern-day pair collapses instead of printing the date twice", () => {
    // 12:00Z start, 03:59:59Z-next-day end: two different UTC days, ONE Eastern
    // day. Comparing UTC components here printed "Sat, Sep 26, 2026 - Sat, Sep
    // 26, 2026".
    expect(
      formatDateRange(new Date("2026-09-26T12:00:00Z"), new Date("2026-09-27T03:59:59Z"))
    ).toBe("Sat, Sep 26, 2026");
  });

  it("a genuine multi-day range still renders as a range", () => {
    expect(
      formatDateRange(new Date("2026-09-20T12:00:00Z"), new Date("2026-09-21T12:00:00Z"))
    ).toBe("Sun, Sep 20, 2026 - Mon, Sep 21, 2026");
  });
});

describe("toIsoDateOnly vs toIsoDateOnlyInVenueZone are deliberately different", () => {
  it("the storage helper reports UTC components — that is its job", () => {
    // Kept as-is so it still round-trips with parseDateOnly / normalizeEventDate.
    expect(toIsoDateOnly(new Date("2026-09-27T03:59:59Z"))).toBe("2026-09-27");
  });

  it("the display helper reports what the page shows", () => {
    expect(toIsoDateOnlyInVenueZone(new Date("2026-09-27T03:59:59Z"))).toBe("2026-09-26");
  });

  it("they agree on the noon anchor — the corpus's dominant convention", () => {
    const d = new Date("2026-09-20T12:00:00Z");
    expect(toIsoDateOnly(d)).toBe(toIsoDateOnlyInVenueZone(d));
  });
});

describe("getVenueZoneYear", () => {
  it("a New Year's Eve event belongs to the year it happens in", () => {
    // 2026-12-31 23:59:59 ET is stored 2027-01-01T04:59:59Z, whose UTC year is
    // 2027 — the wrong year for an occurrence route or an SEO title.
    const nye = new Date("2027-01-01T04:59:59Z");
    expect(nye.getUTCFullYear()).toBe(2027);
    expect(getVenueZoneYear(nye)).toBe(2026);
  });

  it("returns null on unusable input rather than a plausible number", () => {
    expect(getVenueZoneYear(null)).toBeNull();
    expect(getVenueZoneYear("not-a-date")).toBeNull();
  });
});
