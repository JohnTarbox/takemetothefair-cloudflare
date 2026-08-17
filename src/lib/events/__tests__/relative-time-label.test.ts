/**
 * OPE-396 — relative-time labels.
 *
 * The acceptance criterion that carries real risk is "no 'Happening now' on an
 * unconfirmed or ended event", because that label is a factual present-tense
 * claim that could send someone to a field on the wrong day. Most of what
 * follows is that criterion approached from several directions.
 */
import { describe, it, expect } from "vitest";
import { relativeTimeLabel, MAX_DAYS_AHEAD } from "../relative-time-label";
import { weekendWindow } from "../facets";

// A Wednesday, so "today" is unambiguously not a weekend day.
const WED = new Date("2026-08-19T12:00:00Z");
const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("ended events", () => {
  it("labels a finished event Ended", () => {
    const r = relativeTimeLabel(
      { startDate: day("2026-08-01"), endDate: day("2026-08-03"), datesConfirmed: true },
      WED
    );
    expect(r).toEqual({ text: "Ended", tone: "past", hedged: false });
  });

  it("labels an unconfirmed finished event Ended too — the safe direction", () => {
    // Nobody drives anywhere because of an "Ended" label, so the hedge buys
    // nothing here.
    const r = relativeTimeLabel(
      { startDate: day("2026-08-01"), endDate: day("2026-08-03"), datesConfirmed: false },
      WED
    );
    expect(r?.text).toBe("Ended");
  });

  it("an event ending TODAY has not ended", () => {
    const r = relativeTimeLabel(
      { startDate: day("2026-08-17"), endDate: day("2026-08-19"), datesConfirmed: true },
      WED
    );
    expect(r?.text).not.toBe("Ended");
  });
});

describe("'Happening now' is never emitted without confirmed dates", () => {
  it("multi-day confirmed event running today → Happening now", () => {
    const r = relativeTimeLabel(
      { startDate: day("2026-08-18"), endDate: day("2026-08-20"), datesConfirmed: true },
      WED
    );
    expect(r).toEqual({ text: "Happening now", tone: "live", hedged: false });
  });

  it("the SAME event unconfirmed → Expected today, never Happening now", () => {
    const r = relativeTimeLabel(
      { startDate: day("2026-08-18"), endDate: day("2026-08-20"), datesConfirmed: false },
      WED
    );
    expect(r?.text).toBe("Expected today");
    expect(r?.hedged).toBe(true);
  });

  it("a MISSING datesConfirmed is treated as unconfirmed", () => {
    // Unknown provenance must not buy a confident label.
    const r = relativeTimeLabel({ startDate: day("2026-08-18"), endDate: day("2026-08-20") }, WED);
    expect(r?.text).toBe("Expected today");
  });

  it("single-day confirmed event today → Today", () => {
    const r = relativeTimeLabel(
      { startDate: day("2026-08-19"), endDate: day("2026-08-19"), datesConfirmed: true },
      WED
    );
    expect(r).toEqual({ text: "Today", tone: "live", hedged: false });
  });

  it("no vocabulary path produces 'Happening now' while unconfirmed", () => {
    // Swept rather than argued: every offset in range, unconfirmed.
    for (let offset = -3; offset <= MAX_DAYS_AHEAD + 2; offset++) {
      const start = new Date(WED.getTime() + offset * 86_400_000);
      const r = relativeTimeLabel(
        {
          startDate: start,
          endDate: new Date(start.getTime() + 2 * 86_400_000),
          datesConfirmed: false,
        },
        WED
      );
      expect(r?.text ?? "").not.toBe("Happening now");
    }
  });
});

describe("multi-day and discontinuous runs use event_days", () => {
  it("a season-long market is NOT happening now on an off day", () => {
    // The failure this prevents: a May–October range spans today, so a
    // range-only reading says "Happening now" on a Wednesday for a market that
    // only runs Saturdays.
    const r = relativeTimeLabel(
      {
        startDate: day("2026-05-01"),
        endDate: day("2026-10-31"),
        datesConfirmed: true,
        eventDayDates: [day("2026-08-15"), day("2026-08-22"), day("2026-08-29")],
      },
      WED
    );
    expect(r?.text).not.toBe("Happening now");
    // 2026-08-22 is the Saturday of the current weekend.
    expect(r?.text).toBe("This weekend");
  });

  it("counts to the next RUNNING day, not the series start", () => {
    const r = relativeTimeLabel(
      {
        startDate: day("2026-05-01"),
        endDate: day("2026-10-31"),
        datesConfirmed: true,
        eventDayDates: [day("2026-06-01"), day("2026-09-10")],
      },
      WED
    );
    // Next running day is 22 days out; the May start is behind us.
    expect(r?.text).toBe("In 22 days");
  });

  it("an event_day today wins even inside a long range", () => {
    const r = relativeTimeLabel(
      {
        startDate: day("2026-05-01"),
        endDate: day("2026-10-31"),
        datesConfirmed: true,
        eventDayDates: [day("2026-08-19")],
      },
      WED
    );
    expect(r?.text).toBe("Today");
  });
});

describe("weekend agreement with the facet page", () => {
  it("uses the same window the this-weekend facet filters on", () => {
    const w = weekendWindow(WED);
    const saturday = new Date(w.start.getTime() + 86_400_000);
    const r = relativeTimeLabel(
      { startDate: saturday, endDate: saturday, datesConfirmed: true },
      WED
    );
    expect(r?.text).toBe("This weekend");
  });

  it("the day AFTER the window closes is not 'this weekend'", () => {
    const w = weekendWindow(WED);
    const monday = new Date(w.end.getTime());
    const r = relativeTimeLabel({ startDate: monday, endDate: monday, datesConfirmed: true }, WED);
    expect(r?.text).not.toBe("This weekend");
  });

  it("tomorrow beats the weekend label when both could apply", () => {
    // A Friday event seen on Thursday is both "tomorrow" and "this weekend";
    // "Tomorrow" is the more useful of two true statements.
    const thursday = new Date("2026-08-20T12:00:00Z");
    const w = weekendWindow(thursday);
    const r = relativeTimeLabel(
      { startDate: w.start, endDate: w.start, datesConfirmed: true },
      thursday
    );
    expect(r?.text).toBe("Tomorrow");
  });
});

describe("day counts", () => {
  it("counts days for a nearby future event", () => {
    const r = relativeTimeLabel(
      { startDate: day("2026-09-01"), endDate: day("2026-09-02"), datesConfirmed: true },
      WED
    );
    expect(r?.text).toBe("In 13 days");
  });

  it("says nothing at all past the horizon, rather than something useless", () => {
    // "In 200 days" is not information a person can act on; the absolute date
    // already on the card is better.
    const far = new Date(WED.getTime() + (MAX_DAYS_AHEAD + 5) * 86_400_000);
    expect(
      relativeTimeLabel({ startDate: far, endDate: far, datesConfirmed: true }, WED)
    ).toBeNull();
  });

  it("returns null when there is no usable date", () => {
    expect(
      relativeTimeLabel({ startDate: null, endDate: null, datesConfirmed: true }, WED)
    ).toBeNull();
    expect(
      relativeTimeLabel({ startDate: "not-a-date", endDate: null, datesConfirmed: true }, WED)
    ).toBeNull();
  });

  it("tone is carried as data, not inferred from the copy", () => {
    const soon = relativeTimeLabel(
      { startDate: day("2026-08-21"), endDate: day("2026-08-21"), datesConfirmed: true },
      WED
    );
    expect(soon?.tone).toBe("imminent");
    const later = relativeTimeLabel(
      { startDate: day("2026-09-10"), endDate: day("2026-09-10"), datesConfirmed: true },
      WED
    );
    expect(later?.tone).toBe("upcoming");
  });
});
