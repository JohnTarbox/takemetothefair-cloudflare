import { parseWallClockInVenueZone, formatIsoInVenueZone } from "@/lib/datetime";

/**
 * The one rule for turning an `events.start_date` / `end_date` column into a
 * JSON-LD `startDate` / `endDate`. Shared by the single-Event builder
 * (EventSchema.tsx) and the EventSeries builder (series-schema-org.ts via
 * occurrence-view.ts / series-landing-page.tsx).
 *
 * OPE-1547 — this lived inside EventSchema.tsx, so only the event page used it.
 * The series landing formatted every occurrence with `toIsoDateOnlyInVenueZone`
 * instead, throwing the time away: a dated farmers-market instance whose slug is
 * also its series' canonical slug (e.g. `/events/rutland-winter-farmers-market-
 * 2026-11-07`) renders as a series landing and served `"startDate":"2026-11-07"`
 * while the same event, on the event-page path, would have served
 * `T10:00:00-05:00`. One function, two callers, so the two pages cannot drift.
 */

/** The `event_days` fields this rule reads. */
export interface JsonLdEventDay {
  date: string;
  openTime: string | null;
  closeTime: string | null;
  closed?: boolean | null;
}

/**
 * OPE-1241 — exactly 12:00:00.000 UTC is `normalizeEventDate`'s DATE-ONLY
 * sentinel ("we know the day, not the hour"), not a time. Rendered in Eastern it
 * reads 08:00, so the JSON-LD told search engines A Different Drummer opened at
 * 8 AM (it opens at 10) and ENDED at 8 AM on its last day. 356 of the upcoming
 * starts carried it on 2026-10-01.
 */
export function isDateOnlySentinel(d: Date): boolean {
  return (
    d.getUTCHours() === 12 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  );
}

/**
 * A start/end column value as JSON-LD. A real instant is emitted as-is in the
 * venue zone. The date-only sentinel takes that day's hours from event_days
 * (earliest open for the start, latest close for the end), and with no hours on
 * that day it is emitted as a bare date, which schema.org accepts.
 */
export function columnDateForJsonLd(
  value: Date,
  edge: "start" | "end",
  eventDays: JsonLdEventDay[] | undefined,
  venueTz: string | undefined
): string | undefined {
  if (!isDateOnlySentinel(value)) return formatIsoInVenueZone(value, venueTz) || undefined;
  // Noon UTC falls on the same calendar day in every US zone.
  const day = value.toISOString().slice(0, 10);
  const instants = (eventDays ?? [])
    .filter((d) => d.date === day && !d.closed && d.openTime != null && d.closeTime != null)
    .map((d) =>
      parseWallClockInVenueZone(day, (edge === "start" ? d.openTime : d.closeTime)!, venueTz)
    )
    .filter((x): x is Date => x != null);
  if (instants.length === 0) return day;
  const pick = instants.reduce((a, b) => ((edge === "start" ? a < b : a > b) ? a : b), instants[0]);
  return formatIsoInVenueZone(pick, venueTz) || day;
}
