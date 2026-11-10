/**
 * OPE-1510 — "one business day", in America/New_York.
 *
 * The target is the END of the next business day after the message arrived, so
 * mail on Friday afternoon is due Monday night and mail on a holiday weekend is
 * due the first working day after it. Weekends and US federal holidays (with
 * their observed days) are skipped.
 */
import {
  addDaysIso,
  parseWallClockInVenueZone,
  toIsoDateOnlyInVenueZone,
} from "@takemetothefair/datetime";

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

const dayOfWeek = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`).getUTCDay();

/** The nth `weekday` of a month (1-based). */
function nthWeekday(y: number, m: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return iso(y, m, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
}

function lastMonday(y: number, m: number): string {
  const last = new Date(Date.UTC(y, m, 0));
  return iso(y, m, last.getUTCDate() - ((last.getUTCDay() - 1 + 7) % 7));
}

/** A fixed-date holiday on a weekend is observed on the nearest weekday. */
function observed(isoDate: string): string {
  const dow = dayOfWeek(isoDate);
  return dow === 6 ? addDaysIso(isoDate, -1) : dow === 0 ? addDaysIso(isoDate, 1) : isoDate;
}

function federalHolidays(y: number): string[] {
  return [
    observed(iso(y, 1, 1)),
    nthWeekday(y, 1, 1, 3),
    nthWeekday(y, 2, 1, 3),
    lastMonday(y, 5),
    observed(iso(y, 6, 19)),
    observed(iso(y, 7, 4)),
    nthWeekday(y, 9, 1, 1),
    nthWeekday(y, 10, 1, 2),
    observed(iso(y, 11, 11)),
    nthWeekday(y, 11, 4, 4),
    observed(iso(y, 12, 25)),
  ];
}

export function isBusinessDay(isoDate: string): boolean {
  const dow = dayOfWeek(isoDate);
  if (dow === 0 || dow === 6) return false;
  const y = Number(isoDate.slice(0, 4));
  // The next year too: New Year's Day on a Saturday is observed on Dec 31.
  return ![...federalHolidays(y), ...federalHolidays(y + 1)].includes(isoDate);
}

/** 23:59 New York on the first business day after `from`'s New York date. */
export function contactObligationTarget(from: Date): Date {
  let day = addDaysIso(toIsoDateOnlyInVenueZone(from), 1);
  while (!isBusinessDay(day)) day = addDaysIso(day, 1);
  // parseWallClockInVenueZone returns null only for malformed input; `day` is
  // always an ISO date here.
  return parseWallClockInVenueZone(day, "23:59")!;
}
