/**
 * OPE-1219 — event_days left outside an event's date range after a date move.
 *
 * `update_event` moves start_date/end_date and leaves event_days alone. On
 * Peabody International Festival that put the header on Oct 4 and the day list
 * on Sep 27 — the page disagreed with itself until someone noticed. The write
 * stays permissive (moving days is a separate decision: is it the same day
 * shifted, or a different schedule?), but the caller is now told.
 */

/** The calendar day a stored instant falls on in Eastern time, as YYYY-MM-DD. */
export function easternDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** event_days dates (YYYY-MM-DD) that fall outside [start, end], sorted. */
export function eventDaysOutsideRange(
  dayDates: string[],
  startDate: Date | null | undefined,
  endDate: Date | null | undefined
): string[] {
  if (!startDate) return [];
  const from = easternDay(startDate);
  const to = easternDay(endDate ?? startDate);
  return dayDates.filter((d) => d < from || d > to).sort();
}
