/**
 * OPE-1547 — a series landing's JSON-LD dates carry the time the event page
 * would emit for the same occurrence.
 *
 * A dated farmers-market instance whose slug is ALSO its series' canonical slug
 * renders as a series landing. Before this, that page served
 * `"startDate":"2026-11-07"` (date-only) for a market whose row opens at 10:00,
 * while every non-series event page served `"2026-11-07T10:00:00-05:00"`.
 * Measured live 2026-10-31 on /events/rutland-winter-farmers-market-2026-11-07.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { toSchemaOccurrences, occurrenceJsonLdDates } from "../occurrence-view";
import { buildEventSeriesJsonLd } from "../series-schema-org";
import { EventSchema } from "@/components/seo/EventSchema";

/** The real Rutland row: start 15:00Z / end 19:00Z, day row 10:00–14:00. */
const RUTLAND = {
  id: "db19ced9",
  slug: "rutland-winter-farmers-market-2026-11-07",
  name: "Rutland Winter Farmers Market",
  startDate: new Date("2026-11-07T15:00:00Z"),
  endDate: new Date("2026-11-07T19:00:00Z"),
  venue: null,
  eventDays: [{ date: "2026-11-07", openTime: "10:00", closeTime: "14:00", closed: false }],
  venueTimezone: "America/New_York",
};

const noon = (d: string) => new Date(`${d}T12:00:00.000Z`);

describe("series JSON-LD dates keep the occurrence's hours (OPE-1547)", () => {
  it("a real-instant occurrence emits its time with the Eastern offset", () => {
    const [node] = toSchemaOccurrences([RUTLAND as never]);
    expect(node.startDateIso).toBe("2026-11-07T10:00:00-05:00");
    expect(node.endDateIso).toBe("2026-11-07T14:00:00-05:00");
  });

  it("a noon date-only occurrence takes its hours from event_days", () => {
    const [node] = toSchemaOccurrences([
      {
        ...RUTLAND,
        startDate: noon("2026-11-07"),
        endDate: noon("2026-11-07"),
        eventDays: [{ date: "2026-11-07", openTime: "09:00", closeTime: "16:00", closed: false }],
      } as never,
    ]);
    expect(node.startDateIso).toBe("2026-11-07T09:00:00-05:00");
    expect(node.endDateIso).toBe("2026-11-07T16:00:00-05:00");
  });

  it("a noon date-only occurrence with no hours stays a bare date — never 08:00", () => {
    const [node] = toSchemaOccurrences([
      {
        ...RUTLAND,
        startDate: noon("2026-11-07"),
        endDate: noon("2026-11-07"),
        eventDays: [],
      } as never,
    ]);
    expect(node.startDateIso).toBe("2026-11-07");
    expect(node.endDateIso).toBe("2026-11-07");
  });

  it("a closed day row does not lend its hours", () => {
    const { startDateIso } = occurrenceJsonLdDates({
      startDate: noon("2026-11-07"),
      endDate: null,
      eventDays: [{ date: "2026-11-07", openTime: "09:00", closeTime: "16:00", closed: true }],
      venueTimezone: "America/New_York",
    });
    expect(startDateIso).toBe("2026-11-07");
  });

  it("the series node and its subEvent both carry the time", () => {
    const occs = toSchemaOccurrences([RUTLAND as never]);
    const ld = buildEventSeriesJsonLd(
      {
        canonicalSlug: RUTLAND.slug,
        editionMode: "annual",
        name: RUTLAND.name,
        description: null,
        imageUrl: null,
        ...occurrenceJsonLdDates(RUTLAND),
      } as never,
      occs,
      new Date("2026-10-31T18:00:00Z")
    ) as Record<string, unknown> & { subEvent: Array<Record<string, unknown>> };
    expect(ld.startDate).toBe("2026-11-07T10:00:00-05:00");
    expect(ld.subEvent[0].startDate).toBe("2026-11-07T10:00:00-05:00");
  });

  it("emits exactly what the event page's EventSchema emits for the same row", () => {
    // Parity by a second route: render the single-Event builder and read the
    // date out of its served <script>, rather than trusting the shared helper.
    for (const row of [
      RUTLAND,
      {
        ...RUTLAND,
        startDate: noon("2026-11-07"),
        endDate: noon("2026-11-07"),
      },
    ]) {
      const { container } = render(
        <EventSchema
          name={row.name}
          slug={row.slug}
          startDate={row.startDate}
          endDate={row.endDate}
          url="https://meetmeatthefair.com/x"
          venue={{ name: "V", timezone: row.venueTimezone } as never}
          eventDays={row.eventDays}
        />
      );
      const json = JSON.parse(
        container.querySelector('script[type="application/ld+json"]')!.textContent!
      );
      const [node] = toSchemaOccurrences([row as never]);
      expect(node.startDateIso).toBe(json.startDate);
      expect(node.endDateIso).toBe(json.endDate);
    }
  });
});
