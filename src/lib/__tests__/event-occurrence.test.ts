import { describe, it, expect } from "vitest";
import { nextOccurrence, displayDate, showsNextOccurrence } from "../event-occurrence";

const NOW = new Date("2026-06-15T12:00:00Z");

function d(yyyymmdd: string): Date {
  // Match the helper's parseDateOnlyUTC anchor (noon UTC) so
  // assertions can be exact.
  const [y, m, dd] = yyyymmdd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd, 12, 0, 0));
}

describe("nextOccurrence", () => {
  describe("Path 1: event_days populated", () => {
    it("returns the next future event_day date", () => {
      const occ = nextOccurrence(
        {
          startDate: "2026-05-16",
          endDate: "2026-08-30",
          discontinuousDates: true,
          eventDayDates: ["2026-05-16", "2026-06-20", "2026-07-04", "2026-08-29"],
        },
        NOW
      );
      expect(occ?.date).toEqual(d("2026-06-20"));
      expect(occ?.isDataQualityGap).toBe(false);
      // Span first→last for the calendar bar.
      expect(occ?.totalSpanDays).toBeGreaterThan(100);
    });

    it("returns null when all event_days are past", () => {
      const occ = nextOccurrence(
        {
          startDate: "2025-01-01",
          endDate: "2025-01-31",
          discontinuousDates: true,
          eventDayDates: ["2025-01-01", "2025-01-15"],
        },
        NOW
      );
      expect(occ).toBeNull();
    });
  });

  describe("Path 2: discontinuous but no event_days (data quality gap)", () => {
    it("flags isDataQualityGap and falls back to startDate", () => {
      const occ = nextOccurrence(
        {
          startDate: "2026-07-01",
          endDate: "2026-10-31",
          discontinuousDates: true,
          eventDayDates: [],
        },
        NOW
      );
      expect(occ?.date.toISOString()).toBe(new Date("2026-07-01").toISOString());
      expect(occ?.isDataQualityGap).toBe(true);
    });

    it("returns null when the data-quality-gap event has already ended", () => {
      const occ = nextOccurrence(
        {
          startDate: "2024-01-01",
          endDate: "2024-12-31",
          discontinuousDates: true,
          eventDayDates: [],
        },
        NOW
      );
      expect(occ).toBeNull();
    });
  });

  describe("Path 3: contiguous range", () => {
    it("returns today (isOngoing=true) when the event is currently running", () => {
      const occ = nextOccurrence(
        {
          startDate: "2026-06-10",
          endDate: "2026-06-20",
          discontinuousDates: false,
        },
        NOW
      );
      expect(occ?.isOngoing).toBe(true);
      expect(occ?.isContinuousMultiDay).toBe(true);
      // Today (NOW = 2026-06-15) anchored to noon UTC.
      expect(occ?.date.getUTCDate()).toBe(15);
      expect(occ?.totalSpanDays).toBe(11);
    });

    it("returns startDate for a future event", () => {
      const occ = nextOccurrence(
        {
          startDate: "2026-09-01",
          endDate: "2026-09-03",
          discontinuousDates: false,
        },
        NOW
      );
      expect(occ?.date.toISOString()).toBe(new Date("2026-09-01").toISOString());
      expect(occ?.isOngoing).toBe(false);
      expect(occ?.isContinuousMultiDay).toBe(true);
      expect(occ?.totalSpanDays).toBe(3);
    });

    it("returns null for a past event with no future occurrences", () => {
      const occ = nextOccurrence(
        {
          startDate: "2024-09-01",
          endDate: "2024-09-03",
          discontinuousDates: false,
        },
        NOW
      );
      expect(occ).toBeNull();
    });

    it("isContinuousMultiDay=false for single-day events", () => {
      const occ = nextOccurrence(
        {
          startDate: "2026-08-15",
          endDate: "2026-08-15",
          discontinuousDates: false,
        },
        NOW
      );
      expect(occ?.isContinuousMultiDay).toBe(false);
      expect(occ?.totalSpanDays).toBe(1);
    });
  });

  describe("invalid input", () => {
    it("returns null when startDate is null", () => {
      const occ = nextOccurrence({
        startDate: null,
        endDate: null,
        discontinuousDates: false,
      });
      expect(occ).toBeNull();
    });
  });
});

describe("displayDate", () => {
  it("returns the nextOccurrence date when available", () => {
    const result = displayDate(
      {
        startDate: "2026-06-10",
        endDate: "2026-06-20",
        discontinuousDates: false,
      },
      NOW
    );
    // NOW is in range → "today" anchor.
    expect(result?.getUTCDate()).toBe(15);
  });

  it("falls back to startDate when nextOccurrence is null", () => {
    // Past event — nextOccurrence returns null, but displayDate
    // surfaces startDate so the past-events list still has a date
    // to render.
    const result = displayDate(
      {
        startDate: "2024-01-15",
        endDate: "2024-01-15",
        discontinuousDates: false,
      },
      NOW
    );
    expect(result?.toISOString()).toBe(new Date("2024-01-15").toISOString());
  });
});

describe("showsNextOccurrence", () => {
  // A weekly market May–Oct, viewed mid-season — event_days have gaps → series.
  it("true for a recurring season already underway (the Machias case)", () => {
    const occ = nextOccurrence(
      {
        startDate: "2026-05-01",
        endDate: "2026-10-30",
        discontinuousDates: true,
        eventDayDates: ["2026-05-01", "2026-06-05", "2026-06-19", "2026-07-03", "2026-10-30"],
      },
      NOW
    );
    expect(showsNextOccurrence(occ)).toBe(true);
  });

  // The fix: a NOT-yet-started weekly market (first market day = the start) is
  // still a series and shows "Next: <first day>", not a months-long range.
  it("true for a NOT-yet-started weekly market (the Bridgewater case)", () => {
    const occ = nextOccurrence(
      {
        startDate: "2026-08-01",
        endDate: "2026-10-24",
        discontinuousDates: true,
        // Weekly Saturdays, all in the future relative to NOW (2026-06-15).
        eventDayDates: ["2026-08-01", "2026-08-08", "2026-08-15", "2026-08-22"],
      },
      NOW
    );
    expect(occ?.date?.toISOString()).toContain("2026-08-01"); // next == first == start
    expect(showsNextOccurrence(occ)).toBe(true); // still a series, not a range
  });

  it("false for a single-day event", () => {
    const occ = nextOccurrence(
      { startDate: "2026-07-04", endDate: "2026-07-04", discontinuousDates: false },
      NOW
    );
    expect(showsNextOccurrence(occ)).toBe(false);
  });

  it("false for a CONTIGUOUS multi-day fair (consecutive event_days, no gaps)", () => {
    const occ = nextOccurrence(
      {
        startDate: "2026-08-01",
        endDate: "2026-08-03",
        discontinuousDates: false,
        eventDayDates: ["2026-08-01", "2026-08-02", "2026-08-03"],
      },
      NOW
    );
    expect(showsNextOccurrence(occ)).toBe(false);
  });

  it("false when the event is in progress (ongoing, no event_days)", () => {
    const occ = nextOccurrence(
      { startDate: "2026-06-10", endDate: "2026-06-20", discontinuousDates: false },
      NOW
    );
    expect(showsNextOccurrence(occ)).toBe(false);
  });

  it("false when occurrence is null (past event)", () => {
    expect(showsNextOccurrence(null)).toBe(false);
  });
});

import { findNextUpcoming } from "../recurring-display";

describe("today counts as upcoming (noon-UTC boundary fix)", () => {
  // 2026-06-21 is a Sunday; 19:00Z is well past the noon-UTC anchor (8am ET).
  const AFTERNOON = new Date("2026-06-21T19:00:00Z");

  it("findNextUpcoming returns TODAY even after noon UTC", () => {
    expect(findNextUpcoming(["2026-06-14", "2026-06-21", "2026-06-28"], AFTERNOON)).toBe(
      "2026-06-21"
    );
  });

  it("nextOccurrence resolves to today (isToday) for a series whose last day is today", () => {
    // Robin Hood's shape: weekend faire, final day = today.
    const occ = nextOccurrence(
      {
        startDate: "2026-05-16",
        endDate: "2026-06-21",
        discontinuousDates: true,
        eventDayDates: ["2026-05-16", "2026-05-17", "2026-06-20", "2026-06-21"],
      },
      AFTERNOON
    );
    expect(occ?.date).toEqual(d("2026-06-21"));
    expect(occ?.isToday).toBe(true);
    // Still a recurring series → cards show "Today" (showsNextOccurrence true).
    expect(showsNextOccurrence(occ)).toBe(true);
  });

  it("a contiguous event whose last day is today still reads in-progress (not past)", () => {
    const occ = nextOccurrence(
      { startDate: "2026-06-19", endDate: "2026-06-21", discontinuousDates: false },
      AFTERNOON
    );
    expect(occ).not.toBeNull();
    expect(occ?.isOngoing).toBe(true);
    expect(occ?.isToday).toBe(true);
  });

  it("an event that ended YESTERDAY is still past", () => {
    const occ = nextOccurrence(
      { startDate: "2026-06-18", endDate: "2026-06-20", discontinuousDates: false },
      AFTERNOON
    );
    expect(occ).toBeNull();
  });
});
