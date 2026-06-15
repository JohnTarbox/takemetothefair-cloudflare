import { describe, it, expect } from "vitest";
import { toCalendarEvent, toCalendarEvents, type CalendarEventInput } from "../to-calendar-event";
import { validateWindow, validateConfig } from "@jonnyboats/calendar-contract";
import { isEventOngoing } from "@jonnyboats/calendar-core";

const CFG = validateConfig({ displayTimeZone: "America/New_York" }).data!;

// Minimal row factory — only the fields the adapter reads matter; the rest are
// cast through so we don't have to construct a full 60-column events row.
function row(partial: Partial<CalendarEventInput>): CalendarEventInput {
  return {
    id: "e1",
    name: "Test Fair",
    slug: "test-fair",
    categories: "[]",
    discontinuousDates: false,
    startDate: new Date(Date.UTC(2026, 6, 10)), // 2026-07-10
    endDate: null,
    venue: null,
    ...partial,
  } as CalendarEventInput;
}

describe("toCalendarEvent — continuous events", () => {
  it("single-day event emits one occurrence with no end (DTEND omitted)", () => {
    const e = toCalendarEvent(
      row({ startDate: new Date(Date.UTC(2026, 6, 10)), endDate: new Date(Date.UTC(2026, 6, 10)) })
    );
    expect(e).not.toBeNull();
    expect(e!.occurrences).toHaveLength(1);
    expect(e!.occurrences[0]!.start).toBe("2026-07-10");
    expect(e!.occurrences[0]!.end).toBeUndefined();
    expect(e!.occurrences[0]!.allDay).toBe(true);
  });

  it("3-day Fri–Sun event has EXCLUSIVE end = Mon (the off-by-one)", () => {
    // Fri 2026-07-10 … Sun 2026-07-12 inclusive ⇒ end (exclusive) = Mon 2026-07-13.
    const e = toCalendarEvent(
      row({ startDate: new Date(Date.UTC(2026, 6, 10)), endDate: new Date(Date.UTC(2026, 6, 12)) })
    );
    expect(e!.occurrences[0]!.start).toBe("2026-07-10");
    expect(e!.occurrences[0]!.end).toBe("2026-07-13"); // NOT 2026-07-12, NOT 2026-07-14
  });

  it("null start date is skipped (un-placeable)", () => {
    expect(toCalendarEvent(row({ startDate: null }))).toBeNull();
    expect(toCalendarEvents([row({ startDate: null }), row({ id: "ok" })])).toHaveLength(1);
  });
});

describe("toCalendarEvent — ongoing (>14d) derivation by the engine", () => {
  it("a 20-day span is ongoing; an exactly-14-day span is NOT (strict >)", () => {
    const twenty = toCalendarEvent(
      row({
        id: "long",
        startDate: new Date(Date.UTC(2026, 6, 1)),
        endDate: new Date(Date.UTC(2026, 6, 21)),
      })
    )!;
    // exactly 14 days inclusive: 07-01 … 07-14 ⇒ span end-exclusive 07-15, length 14d.
    const fourteen = toCalendarEvent(
      row({
        id: "two-wk",
        startDate: new Date(Date.UTC(2026, 6, 1)),
        endDate: new Date(Date.UTC(2026, 6, 14)),
      })
    )!;
    expect(isEventOngoing(twenty, CFG)).toBe(true);
    expect(isEventOngoing(fourteen, CFG)).toBe(false);
  });
});

describe("toCalendarEvent — discontinuous events", () => {
  it("emits one occurrence per event_days date, sorted ascending, stable ids", () => {
    const e = toCalendarEvent(
      row({
        id: "disc",
        discontinuousDates: true,
        eventDayDates: ["2026-07-11", "2026-07-04", "2026-07-04", "2026-07-01"],
      })
    )!;
    expect(e.occurrences.map((o) => o.start)).toEqual(["2026-07-01", "2026-07-04", "2026-07-11"]);
    expect(e.occurrences.map((o) => o.id)).toEqual([
      "disc:2026-07-01",
      "disc:2026-07-04",
      "disc:2026-07-11",
    ]);
    expect(e.occurrences.every((o) => o.allDay && o.end === undefined)).toBe(true);
  });

  it("discontinuous flag with no dates falls back to the continuous span", () => {
    const e = toCalendarEvent(row({ discontinuousDates: true, eventDayDates: [] }))!;
    expect(e.occurrences).toHaveLength(1);
    expect(e.occurrences[0]!.id).toBe("e1:0");
  });
});

describe("toCalendarEvent — scalar fields", () => {
  it("maps category[0], url, and venue location/mapUrl", () => {
    const e = toCalendarEvent(
      row({
        categories: JSON.stringify(["Festival", "Music"]),
        venue: {
          name: "Fryeburg Fairgrounds",
          city: "Fryeburg",
          googleMapsUrl: "https://maps.google.com/?q=fryeburg",
        },
      })
    )!;
    expect(e.category).toBe("Festival");
    expect(e.url).toBe("/events/test-fair");
    expect(e.occurrences[0]!.location).toBe("Fryeburg Fairgrounds, Fryeburg");
    expect(e.occurrences[0]!.mapUrl).toBe("https://maps.google.com/?q=fryeburg");
  });

  it("omits category when none, and venue bits when no venue", () => {
    const e = toCalendarEvent(row({ categories: "[]", venue: null }))!;
    expect(e.category).toBeUndefined();
    expect(e.occurrences[0]!.location).toBeUndefined();
    expect(e.occurrences[0]!.mapUrl).toBeUndefined();
  });
});

describe("past-events rule (Step 5) — toCalendarEvents filtering", () => {
  const TODAY = "2026-07-10";

  it("drops past dates of a recurring event by default, keeps them with includePast", () => {
    const r = row({
      id: "weekly",
      discontinuousDates: true,
      eventDayDates: ["2026-07-03", "2026-07-10", "2026-07-17"], // past, today, future
    });
    const def = toCalendarEvents([r], { todayIso: TODAY })[0]!;
    expect(def.occurrences.map((o) => o.start)).toEqual(["2026-07-10", "2026-07-17"]); // 07-03 dropped

    const withPast = toCalendarEvents([r], { includePast: true, todayIso: TODAY })[0]!;
    expect(withPast.occurrences.map((o) => o.start)).toEqual([
      "2026-07-03",
      "2026-07-10",
      "2026-07-17",
    ]);
  });

  it("drops an event whose every occurrence is past", () => {
    const r = row({
      id: "gone",
      startDate: new Date(Date.UTC(2026, 6, 1)),
      endDate: new Date(Date.UTC(2026, 6, 3)),
    });
    expect(toCalendarEvents([r], { todayIso: TODAY })).toHaveLength(0);
    expect(toCalendarEvents([r], { includePast: true, todayIso: TODAY })).toHaveLength(1);
  });

  it("keeps an ongoing multi-day event that spans into the future", () => {
    // starts before today, ends after — still current, not 'past'.
    const r = row({
      id: "ongoing",
      startDate: new Date(Date.UTC(2026, 6, 5)),
      endDate: new Date(Date.UTC(2026, 6, 15)),
    });
    const out = toCalendarEvents([r], { todayIso: TODAY });
    expect(out).toHaveLength(1);
    expect(out[0]!.occurrences[0]!.start).toBe("2026-07-05"); // span kept intact
  });

  it("no filtering when todayIso is omitted (back-compat)", () => {
    const r = row({
      id: "x",
      discontinuousDates: true,
      eventDayDates: ["2020-01-01", "2030-01-01"],
    });
    expect(toCalendarEvents([r])[0]!.occurrences).toHaveLength(2);
  });
});

describe("adapter output passes the contract's validateWindow", () => {
  it("a mixed window is valid (unique ids, occurrences sorted ascending)", () => {
    const out = toCalendarEvents([
      row({
        id: "a",
        startDate: new Date(Date.UTC(2026, 6, 10)),
        endDate: new Date(Date.UTC(2026, 6, 12)),
      }),
      row({ id: "b", discontinuousDates: true, eventDayDates: ["2026-07-20", "2026-07-05"] }),
      row({ id: "c", categories: JSON.stringify(["Craft Fair"]) }),
    ]);
    const result = validateWindow(out);
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
  });
});
