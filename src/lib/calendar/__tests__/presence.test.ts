import { describe, it, expect } from "vitest";
import { buildPresence } from "@jonnyboats/calendar-core";
import { validateConfig } from "@jonnyboats/calendar-contract";
import { parseCalYear } from "../window";
import { toCalendarEvents, type CalendarEventInput } from "../to-calendar-event";

const CFG = validateConfig({ displayTimeZone: "America/New_York" }).data!;

// Minimal row factory — only the fields the adapter reads matter (mirrors
// to-calendar-event.test.ts). The rest are cast through.
function row(partial: Partial<CalendarEventInput>): CalendarEventInput {
  return {
    id: "e1",
    name: "Test Fair",
    slug: "test-fair",
    categories: '["Festival"]',
    discontinuousDates: false,
    startDate: new Date(Date.UTC(2026, 6, 10)), // 2026-07-10
    endDate: null,
    venue: null,
    ...partial,
  } as CalendarEventInput;
}

describe("parseCalYear", () => {
  it("parses a valid 4-digit year", () => {
    expect(parseCalYear("2027")).toBe(2027);
  });

  it("falls back to the current UTC year on undefined/garbage", () => {
    const current = new Date().getUTCFullYear();
    expect(parseCalYear(undefined)).toBe(current);
    expect(parseCalYear("nope")).toBe(current);
    expect(parseCalYear("26")).toBe(current);
    expect(parseCalYear("2026-07")).toBe(current);
  });

  it("rejects out-of-range years (defends the presence query)", () => {
    const current = new Date().getUTCFullYear();
    expect(parseCalYear("1999")).toBe(current);
    expect(parseCalYear("2101")).toBe(current);
    expect(parseCalYear("2000")).toBe(2000); // inclusive lower bound
    expect(parseCalYear("2100")).toBe(2100); // inclusive upper bound
  });
});

// The Year data path is: adapter (toCalendarEvents) → buildPresence. These assert
// our adapter output feeds buildPresence to the expected per-day per-category map,
// which is the only contract the SSR Year component relies on.
describe("Year presence — adapter → buildPresence", () => {
  it("dots every day a multi-day event spans, with its category", () => {
    const events = toCalendarEvents(
      [
        row({
          startDate: new Date(Date.UTC(2026, 6, 10)),
          endDate: new Date(Date.UTC(2026, 6, 12)),
        }),
      ],
      { includePast: true }
    );
    const presence = buildPresence(events, CFG, 2026);

    expect(presence["2026-07-10"]).toContain("Festival");
    expect(presence["2026-07-11"]).toContain("Festival");
    expect(presence["2026-07-12"]).toContain("Festival");
    // DTEND is exclusive — the day after the last day is NOT dotted.
    expect(presence["2026-07-13"]).toBeUndefined();
  });

  it("dots each discontinuous date independently (not the gaps between)", () => {
    const events = toCalendarEvents(
      [
        row({
          discontinuousDates: true,
          eventDayDates: ["2026-08-01", "2026-08-08", "2026-08-15"],
        }),
      ],
      { includePast: true }
    );
    const presence = buildPresence(events, CFG, 2026);

    expect(presence["2026-08-01"]).toContain("Festival");
    expect(presence["2026-08-08"]).toContain("Festival");
    expect(presence["2026-08-15"]).toContain("Festival");
    // The gap days between the discrete dates carry no presence.
    expect(presence["2026-08-02"]).toBeUndefined();
  });

  it("excludes days outside the requested year", () => {
    const events = toCalendarEvents(
      [
        row({
          startDate: new Date(Date.UTC(2025, 11, 30)),
          endDate: new Date(Date.UTC(2025, 11, 31)),
        }),
      ],
      { includePast: true }
    );
    const presence = buildPresence(events, CFG, 2026);
    expect(Object.keys(presence)).toHaveLength(0);
  });
});
