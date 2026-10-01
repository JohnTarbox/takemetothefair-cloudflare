/**
 * OPE-1241 — a noon-UTC column value is normalizeEventDate's date-only
 * sentinel. Emitted as an instant it read 08:00 Eastern: A Different Drummer
 * "opened at 8 AM" (it opens at 10) and "ended at 8 AM" on its last day.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { EventSchema, isDateOnlySentinel } from "../EventSchema";

function ld(container: HTMLElement): Record<string, unknown> {
  const s = container.querySelector('script[type="application/ld+json"]');
  return JSON.parse(s!.textContent || "{}");
}
const noon = (d: string) => new Date(`${d}T12:00:00Z`);
const base = {
  name: "A Different Drummer Craft Fair",
  slug: "a-different-drummer-craft-fair-october-2026",
  url: "https://meetmeatthefair.com/events/a-different-drummer-craft-fair-october/2026",
  venue: { name: "Hall", city: "Cicero", state: "NY", timezone: "America/New_York" },
  stateCode: "NY",
  organizer: null,
  lifecycleStatus: "SCHEDULED",
} as unknown as ComponentProps<typeof EventSchema>;

describe("OPE-1241 — date-only sentinel in Event JSON-LD", () => {
  it("takes the first day's open and the last day's close from event_days", () => {
    const { container } = render(
      <EventSchema
        {...base}
        startDate={noon("2026-10-03")}
        endDate={noon("2026-10-04")}
        eventDays={[
          { date: "2026-10-03", openTime: "10:00", closeTime: "16:00" },
          { date: "2026-10-04", openTime: "10:00", closeTime: "16:00" },
        ]}
      />
    );
    const j = ld(container);
    expect(j.startDate).toBe("2026-10-03T10:00:00-04:00");
    expect(j.endDate).toBe("2026-10-04T16:00:00-04:00");
  });

  it("emits a bare date when that day has no captured hours", () => {
    const { container } = render(
      <EventSchema
        {...base}
        startDate={noon("2026-10-03")}
        endDate={noon("2026-10-04")}
        eventDays={[]}
      />
    );
    const j = ld(container);
    expect(j.startDate).toBe("2026-10-03");
    expect(j.endDate).toBe("2026-10-04");
  });

  it("ignores event_days on OTHER dates (a stranded day must not lend its hours)", () => {
    const { container } = render(
      <EventSchema
        {...base}
        startDate={noon("2026-10-04")}
        endDate={noon("2026-10-04")}
        eventDays={[{ date: "2026-09-27", openTime: "11:00", closeTime: "17:00" }]}
      />
    );
    expect(ld(container).startDate).toBe("2026-10-04");
  });

  it("control: a real stored time is emitted unchanged (New Haven Chalk Art, 16:00Z)", () => {
    const { container } = render(
      <EventSchema
        {...base}
        startDate={new Date("2026-10-03T16:00:00Z")}
        endDate={new Date("2026-10-03T20:00:00Z")}
        eventDays={[{ date: "2026-10-03", openTime: "09:00", closeTime: "18:00" }]}
      />
    );
    const j = ld(container);
    expect(j.startDate).toBe("2026-10-03T12:00:00-04:00");
    expect(j.endDate).toBe("2026-10-03T16:00:00-04:00");
  });

  it("a date-only previousStartDate is a bare date (Peabody: moved from 09-27)", () => {
    const { container } = render(
      <EventSchema
        {...base}
        lifecycleStatus="RESCHEDULED"
        startDate={noon("2026-10-04")}
        endDate={noon("2026-10-04")}
        previousStartDate={noon("2026-09-27")}
        previousEndDate={noon("2026-09-27")}
      />
    );
    expect(ld(container).previousStartDate).toBe("2026-09-27");
  });

  it("isDateOnlySentinel is exact: noon to the millisecond, nothing else", () => {
    expect(isDateOnlySentinel(noon("2026-10-03"))).toBe(true);
    expect(isDateOnlySentinel(new Date("2026-10-03T12:00:00.001Z"))).toBe(false);
    expect(isDateOnlySentinel(new Date("2026-10-03T16:00:00Z"))).toBe(false);
  });
});
