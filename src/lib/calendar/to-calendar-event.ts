// CAL1 — Step 2 adapter: MMATF `events` (+ `event_days`) → the frozen
// `CalendarEvent` contract (@jonnyboats/calendar-contract, ES §5).
//
// This is the ONE seam MMATF owns. We map our rows into the contract; we never
// fork the module's internals. When the published `.d.ts` changes (major bump),
// this file is the only place that moves. See docs/cal1-schema-reconcile.md for
// the column-by-column field map and the design rationale.
//
// Load-bearing rules (from the contract docs):
//   - All-day occurrences are FLOATING: date-only `start`, no `timezone`, so they
//     never shift day under a different `displayTimeZone`. MMATF stores dates as
//     midnight-UTC anchors, so `toIsoDateOnly` is exact.
//   - All-day `end` is EXCLUSIVE (DTEND): a Fri–Sun event has `end = Mon`. We add
//     one day to the inclusive `endDate`. (Property-tested for the off-by-one.)
//   - `occurrences[]` MUST be sorted ascending by start (validateWindow enforces).
//   - `ongoing` is left UNSET — the engine derives it (TRUE iff any occurrence
//     span > 14d). We only emit occurrences; the band is the engine's job.

import type { CalendarEvent, Occurrence } from "@jonnyboats/calendar-contract";
import {
  toIsoDateOnly,
  addDaysIso,
  parseWallClockInVenueZone,
  VENUE_TZ,
} from "@takemetothefair/datetime";
import { parseJsonArray } from "@/types";
import type { events as eventsTable, venues as venuesTable } from "@/lib/db/schema";

/** "YYYY-MM-DD" of an ISO instant in the given IANA zone (en-CA formats as ISO date). */
function localDayOfInstant(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

type EventRow = typeof eventsTable.$inferSelect;
type VenueRow = typeof venuesTable.$inferSelect;

/**
 * The input shape the adapter reads — a superset of an `events` row plus the joined
 * venue and the pre-loaded discontinuous dates. This is exactly what `getEvents()`'s
 * calendar branch already returns (venue joined, `eventDayDates` attached), so the
 * adapter does no querying of its own.
 */
export type CalendarEventInput = EventRow & {
  venue?: Pick<VenueRow, "name" | "city" | "googleMapsUrl"> | null;
  /** "YYYY-MM-DD" dates for discontinuous events (vendorOnly already filtered by the caller). */
  eventDayDates?: string[];
  /**
   * Per-day hours for discontinuous events (DQ4 `event_days.open_time/close_time`,
   * "HH:MM" or null). When present this supersedes `eventDayDates`: a day with both
   * hours yields a TIMED occurrence, otherwise all-day. Caller filters vendorOnly.
   */
  eventDayHours?: Array<{ date: string; openTime: string | null; closeTime: string | null }>;
};

function venueBits(input: CalendarEventInput): Pick<Occurrence, "location" | "mapUrl"> {
  const v = input.venue;
  if (!v) return {};
  const location = [v.name, v.city].filter(Boolean).join(", ") || undefined;
  const mapUrl = v.googleMapsUrl ?? undefined;
  return {
    ...(location ? { location } : {}),
    ...(mapUrl ? { mapUrl } : {}),
  };
}

/** Continuous event → ONE all-day occurrence spanning start … (end + 1 day, exclusive). */
function continuousOccurrence(input: CalendarEventInput): Occurrence {
  const start = toIsoDateOnly(input.startDate);
  const bits = venueBits(input);
  // DTEND-exclusive: only emit `end` when the event actually spans >1 day.
  let end: string | undefined;
  if (input.endDate) {
    const endDateOnly = toIsoDateOnly(input.endDate);
    if (endDateOnly > start) end = addDaysIso(endDateOnly, 1);
  }
  return {
    id: `${input.id}:0`,
    start,
    ...(end ? { end } : {}),
    allDay: true,
    ...bits,
  };
}

/**
 * One occurrence per event_days date, sorted ascending. A day with BOTH
 * `openTime` and `closeTime` (DQ4 hours) becomes a TIMED occurrence so it lands
 * in the Week/Day hour grid; a day with no/partial hours stays all-day (renders
 * in the all-day strip). Sorting by date keeps `start` ascending across the
 * mixed all-day/timed set (the day prefix dominates the string compare), which
 * validateWindow requires.
 */
function discontinuousOccurrences(input: CalendarEventInput): Occurrence[] {
  const bits = venueBits(input);

  // Prefer the richer hours-bearing shape when present; else legacy dates-only.
  if (input.eventDayHours && input.eventDayHours.length > 0) {
    const seen = new Set<string>();
    return [...input.eventDayHours]
      .sort((a, b) => a.date.localeCompare(b.date))
      .filter((h) => (seen.has(h.date) ? false : (seen.add(h.date), true)))
      .map((h) => dayOccurrence(input, h.date, h.openTime, h.closeTime, bits));
  }

  const dates = Array.from(new Set(input.eventDayDates)).sort();
  return dates.map((date) => dayOccurrence(input, date, null, null, bits));
}

/**
 * A single event-day occurrence: TIMED when both hours are present and the close
 * is after the open (DST-safe via parseWallClockInVenueZone → UTC instant +
 * `timezone`); otherwise an all-day occurrence. A bad/zero/negative span falls
 * back to all-day rather than emitting an unplaceable block.
 */
function dayOccurrence(
  input: CalendarEventInput,
  date: string,
  openTime: string | null,
  closeTime: string | null,
  bits: Pick<Occurrence, "location" | "mapUrl">
): Occurrence {
  const id = `${input.id}:${date}`;
  if (openTime && closeTime) {
    const startD = parseWallClockInVenueZone(date, openTime, VENUE_TZ);
    const endD = parseWallClockInVenueZone(date, closeTime, VENUE_TZ);
    if (startD && endD && endD.getTime() > startD.getTime()) {
      return {
        id,
        start: startD.toISOString(),
        end: endD.toISOString(),
        allDay: false,
        timezone: VENUE_TZ,
        ...bits,
      };
    }
  }
  return { id, start: date, allDay: true, ...bits };
}

/**
 * Map a single MMATF event row to a `CalendarEvent`, or `null` when it can't be
 * placed on a calendar (no start date) — mirrors the existing `if (!startDate)`
 * guard in the events query.
 */
export function toCalendarEvent(input: CalendarEventInput): CalendarEvent | null {
  if (!input.startDate) return null;

  // Discontinuous when the row is flagged AND we have per-day data — either the
  // legacy dates list or the richer hours-bearing shape (DQ4).
  const hasDayData =
    (input.eventDayDates?.length ?? 0) > 0 || (input.eventDayHours?.length ?? 0) > 0;
  const occurrences =
    input.discontinuousDates && hasDayData
      ? discontinuousOccurrences(input)
      : [continuousOccurrence(input)];

  const category = parseJsonArray(input.categories)[0];

  return {
    id: input.id,
    title: input.name,
    ...(category ? { category } : {}),
    url: `/events/${input.slug}`,
    occurrences,
  };
}

export interface ToCalendarOptions {
  /**
   * When false (default), occurrences whose inclusive last day is before
   * `todayIso` are dropped (Step 5: "past days render as empty cells, past
   * events hidden"). Critical for discontinuous/recurring events, whose row is
   * kept by the query as long as ANY date is upcoming — without this the past
   * dates of a weekly series would still render chips on past days.
   */
  includePast?: boolean;
  /** UTC "YYYY-MM-DD" cutoff; required to filter past when includePast is false. */
  todayIso?: string;
}

/**
 * Inclusive first/last calendar day of an occurrence. All-day: date-only, `end`
 * exclusive (subtract a day). Timed: the local day of the start/end instant in
 * the occurrence's zone — NOT the UTC date prefix, which would be off by a day
 * for evening events that cross UTC midnight.
 */
function occurrenceDayBounds(occ: Occurrence): { first: string; last: string } {
  if (occ.allDay) {
    return { first: occ.start, last: occ.end ? addDaysIso(occ.end, -1) : occ.start };
  }
  const tz = occ.timezone ?? VENUE_TZ;
  const first = localDayOfInstant(occ.start, tz);
  return { first, last: occ.end ? localDayOfInstant(occ.end, tz) : first };
}

const isoToUtcMs = (iso: string): number =>
  Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

/**
 * Engine's "ongoing" rule for an all-day occurrence: span (exclusive end − start)
 * strictly greater than 14 days. These render in the band above the grid, never in
 * cells, so we must NOT clip them (clipping shrinks the span and would demote them
 * into day cells). Matches @jonnyboats/calendar-core's isEventOngoing.
 */
function occurrenceSpanExceeds14d(occ: Occurrence): boolean {
  if (!occ.end) return false;
  return (isoToUtcMs(occ.end) - isoToUtcMs(occ.start)) / 86_400_000 > 14;
}

/**
 * Map a window of rows, dropping un-placeable ones (null start). When
 * `opts.includePast` is falsy and `opts.todayIso` is given, apply the Step-5
 * past-events rule so past day cells stay empty:
 *  - drop occurrences that ended before today (and events left with none);
 *  - clip a multi-day occurrence that STARTED before today (but runs into
 *    today/future) so it begins at today — UNLESS it's an ongoing (>14d) band
 *    event, which is excluded from cells and must keep its full span.
 */
export function toCalendarEvents(
  rows: ReadonlyArray<CalendarEventInput>,
  opts: ToCalendarOptions = {}
): CalendarEvent[] {
  const events = rows.map(toCalendarEvent).filter((e): e is CalendarEvent => e !== null);

  if (opts.includePast || !opts.todayIso) return events;
  const today = opts.todayIso;

  const out: CalendarEvent[] = [];
  for (const e of events) {
    const occurrences: Occurrence[] = [];
    for (const o of e.occurrences) {
      const { first, last } = occurrenceDayBounds(o);
      if (last < today) continue; // fully past → drop
      // Clip only the all-day in-cell ribbon (a date-only span) that started in
      // the past but runs into today/future — never timed blocks or ongoing
      // (>14d) band events. Timed occurrences keep their exact start/end.
      if (o.allDay && first < today && o.end && !occurrenceSpanExceeds14d(o)) {
        occurrences.push({ ...o, start: today });
      } else {
        occurrences.push(o); // future, timed, or ongoing band event → keep intact
      }
    }
    if (occurrences.length > 0) out.push({ ...e, occurrences });
  }
  return out;
}
