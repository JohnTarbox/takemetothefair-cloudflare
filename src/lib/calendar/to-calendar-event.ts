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
import { toIsoDateOnly, addDaysIso } from "@takemetothefair/datetime";
import { parseJsonArray } from "@/types";
import type { events as eventsTable, venues as venuesTable } from "@/lib/db/schema";

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

/** Discontinuous event → one all-day occurrence per event_days date, sorted ascending. */
function discontinuousOccurrences(input: CalendarEventInput): Occurrence[] {
  const bits = venueBits(input);
  // Dedupe + sort ascending; "YYYY-MM-DD" sorts chronologically as a string.
  const dates = Array.from(new Set(input.eventDayDates)).sort();
  return dates.map((date) => ({
    id: `${input.id}:${date}`,
    start: date,
    allDay: true,
    ...bits,
  }));
}

/**
 * Map a single MMATF event row to a `CalendarEvent`, or `null` when it can't be
 * placed on a calendar (no start date) — mirrors the existing `if (!startDate)`
 * guard in the events query.
 */
export function toCalendarEvent(input: CalendarEventInput): CalendarEvent | null {
  if (!input.startDate) return null;

  const occurrences =
    input.discontinuousDates && input.eventDayDates && input.eventDayDates.length > 0
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

/** Inclusive last day of an occurrence (all-day `end` is exclusive; single-day has none). */
function occurrenceLastDay(occ: Occurrence): string {
  return occ.end ? addDaysIso(occ.end, -1) : occ.start;
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
      if (occurrenceLastDay(o) < today) continue; // fully past → drop
      if (o.start < today && o.end && !occurrenceSpanExceeds14d(o)) {
        occurrences.push({ ...o, start: today }); // clip in-cell ribbon to today
      } else {
        occurrences.push(o); // future, or ongoing band event → keep intact
      }
    }
    if (occurrences.length > 0) out.push({ ...e, occurrences });
  }
  return out;
}
