/**
 * OPE-1563 — a `vendor_only` event_days row is a setup window, not a public
 * session. GAHS Interact Club Holiday Craft Fair 2026 had, for 2026-12-19, a
 * public row 09:00–14:00 and a vendor_only row 07:00–09:00 "Vendor setup"; the
 * served JSON-LD carried a second subEvent "… - Day 2" starting 07:00. The
 * visible schedule already hid the row.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { EventSchema } from "../EventSchema";
import { isPublicEventDay } from "@/lib/seo/column-date-jsonld";
import { toSchemaOccurrences } from "@/lib/series/occurrence-view";

function ld(container: HTMLElement): Record<string, unknown> {
  const s = container.querySelector('script[type="application/ld+json"]');
  return JSON.parse(s!.textContent || "{}");
}
const noon = (d: string) => new Date(`${d}T12:00:00Z`);
const NAME = "GAHS Interact Club Holiday Craft Fair 2026";
const base = {
  name: NAME,
  slug: "gahs-interact-club-craft-fair-2026-12",
  url: "https://meetmeatthefair.com/events/gahs-interact-club-craft-fair/2026-12",
  venue: { name: "GAHS", city: "Gardiner", state: "ME", timezone: "America/New_York" },
  stateCode: "ME",
  organizer: null,
  lifecycleStatus: "SCHEDULED",
} as unknown as ComponentProps<typeof EventSchema>;

/** The GAHS rows as they stood, vendor-only row second (it rendered as "Day 2"). */
const GAHS_DAYS = [
  { id: "d-public", date: "2026-12-19", openTime: "09:00", closeTime: "14:00", closed: false },
  {
    id: "d-setup",
    date: "2026-12-19",
    openTime: "07:00",
    closeTime: "09:00",
    closed: false,
    vendorOnly: true,
    notes: "Vendor setup",
  },
];

type SubEvent = { name: string; startDate: string; endDate: string; description: string };
const subEvents = (j: Record<string, unknown>) => (j.subEvent ?? []) as SubEvent[];

describe("OPE-1563 — vendor_only days never reach Event JSON-LD", () => {
  it("GAHS: one subEvent, the public hours, named Day 1 — no 07:00 'Day 2'", () => {
    const { container } = render(
      <EventSchema
        {...base}
        startDate={noon("2026-12-19")}
        endDate={noon("2026-12-19")}
        eventDays={GAHS_DAYS}
      />
    );
    const j = ld(container);
    const subs = subEvents(j);
    expect(subs).toHaveLength(1);
    expect(subs[0].name).toBe(`${NAME} - Day 1`);
    expect(subs[0].startDate).toBe("2026-12-19T09:00:00-05:00");
    expect(subs[0].endDate).toBe("2026-12-19T14:00:00-05:00");
    expect(JSON.stringify(j)).not.toContain("Vendor setup");
    expect(JSON.stringify(j)).not.toContain("T07:00:00");
  });

  it("top-level startDate (noon sentinel) takes the PUBLIC open, not the earlier setup open", () => {
    const { container } = render(
      <EventSchema
        {...base}
        startDate={noon("2026-12-19")}
        endDate={noon("2026-12-19")}
        eventDays={GAHS_DAYS}
      />
    );
    const j = ld(container);
    expect(j.startDate).toBe("2026-12-19T09:00:00-05:00");
    expect(j.endDate).toBe("2026-12-19T14:00:00-05:00");
  });

  it("top-level dates derived from event_days alone (null columns) ignore the setup row", () => {
    const { container } = render(
      <EventSchema {...base} startDate={null} endDate={null} eventDays={GAHS_DAYS} />
    );
    const j = ld(container);
    expect(j.startDate).toBe("2026-12-19T09:00:00-05:00");
    expect(j.endDate).toBe("2026-12-19T14:00:00-05:00");
  });

  it("a setup DAY before the fair does not become Day 1 or the start", () => {
    const { container } = render(
      <EventSchema
        {...base}
        startDate={null}
        endDate={null}
        eventDays={[
          { date: "2026-12-18", openTime: "16:00", closeTime: "20:00", vendorOnly: true },
          { date: "2026-12-19", openTime: "09:00", closeTime: "14:00" },
          { date: "2026-12-20", openTime: "10:00", closeTime: "15:00" },
        ]}
      />
    );
    const j = ld(container);
    expect(j.startDate).toBe("2026-12-19T09:00:00-05:00");
    expect(subEvents(j).map((s) => [s.name, s.startDate])).toEqual([
      [`${NAME} - Day 1`, "2026-12-19T09:00:00-05:00"],
      [`${NAME} - Day 2`, "2026-12-20T10:00:00-05:00"],
    ]);
  });

  it("two PUBLIC sessions on one date are both Day 1 — a date never yields a phantom Day 2", () => {
    const { container } = render(
      <EventSchema
        {...base}
        startDate={noon("2026-12-19")}
        endDate={noon("2026-12-19")}
        eventDays={[
          { date: "2026-12-19", openTime: "09:00", closeTime: "12:00" },
          { date: "2026-12-19", openTime: "17:00", closeTime: "20:00" },
        ]}
      />
    );
    expect(subEvents(ld(container)).map((s) => s.name)).toEqual([
      `${NAME} - Day 1`,
      `${NAME} - Day 1`,
    ]);
  });

  it("control: without vendorOnly the same two rows both emit (the filter is what removes it)", () => {
    const { container } = render(
      <EventSchema
        {...base}
        startDate={noon("2026-12-19")}
        endDate={noon("2026-12-19")}
        eventDays={GAHS_DAYS.map((d) => ({ ...d, vendorOnly: false }))}
      />
    );
    const j = ld(container);
    expect(subEvents(j)).toHaveLength(2);
    expect(j.startDate).toBe("2026-12-19T07:00:00-05:00");
  });
});

describe("OPE-1563 — the series landing's occurrence dates use the same predicate", () => {
  it("a noon-sentinel occurrence takes the public open, not the setup open", () => {
    const [node] = toSchemaOccurrences([
      {
        id: "478682d3",
        slug: "gahs-interact-club-craft-fair-2026-12",
        name: NAME,
        startDate: noon("2026-12-19"),
        endDate: noon("2026-12-19"),
        venue: null,
        eventDays: GAHS_DAYS,
        venueTimezone: "America/New_York",
      } as never,
    ]);
    expect(node.startDateIso).toBe("2026-12-19T09:00:00-05:00");
    expect(node.endDateIso).toBe("2026-12-19T14:00:00-05:00");
  });
});

describe("isPublicEventDay", () => {
  it.each([
    [{}, true],
    [{ closed: false, vendorOnly: false }, true],
    [{ closed: null, vendorOnly: null }, true],
    [{ vendorOnly: true }, false],
    [{ closed: true }, false],
  ])("%j → %s", (day, expected) => {
    expect(isPublicEventDay(day)).toBe(expected);
  });
});
