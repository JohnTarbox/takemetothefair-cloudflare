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

/**
 * Public event_days dates (YYYY-MM-DD) that fall outside [start, end], sorted.
 *
 * vendor_only rows are skipped: a setup day before the public start is correct
 * data, not a stranded day (measured 2026-10-01: 5 of the 12 out-of-range rows
 * in prod were exactly that — Sterling's drop-off day, Shaker Hill's setup).
 */
export function eventDaysOutsideRange(
  days: Array<{ date: string; vendorOnly?: boolean | null }>,
  startDate: Date | null | undefined,
  endDate: Date | null | undefined
): string[] {
  if (!startDate) return [];
  const from = easternDay(startDate);
  const to = easternDay(endDate ?? startDate);
  return days
    .filter((d) => !d.vendorOnly && (d.date < from || d.date > to))
    .map((d) => d.date)
    .sort();
}
