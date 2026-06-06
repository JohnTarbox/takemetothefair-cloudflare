// Shared utilities for scrapers — thin re-exports of the canonical helpers
// in @takemetothefair/utils. Existing scraper imports keep working unchanged.
export { decodeHtmlEntities, createSlugFromName } from "@takemetothefair/utils";

// Month-name → 0-based index for Date.UTC(). Lowercase keys; pass any case.
const SCRAPER_MONTH_INDEX: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

/**
 * Build a midnight-UTC `Date` from a month name + day-of-month + year.
 *
 * Returns `null` for unknown month names or calendar-invalid dates (e.g.
 * "February 30"). All scraper-produced Dates anchor at midnight UTC per the
 * project's date-only storage convention (events.startDate / events.endDate
 * are midnight-UTC seconds-epoch values; the time portion is decorative and
 * ignored by every display path).
 *
 * Replaces the historical scraper pattern of `new Date('Month Day, Year')`
 * followed by `.setHours(9, 0, 0, 0)` — that interprets the hour in the
 * runtime's local zone (UTC on Cloudflare Workers), producing a `9:00 UTC`
 * anchor that's off the midnight-UTC convention and silently inconsistent
 * with scrapers that already used Date.UTC. (P3c, 2026-06-06.)
 */
export function monthNameToMidnightUtc(monthName: string, day: number, year: number): Date | null {
  const m = SCRAPER_MONTH_INDEX[monthName.toLowerCase()];
  if (m === undefined) return null;
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  if (!Number.isFinite(year)) return null;
  const d = new Date(Date.UTC(year, m, day));
  if (isNaN(d.getTime())) return null;
  // Guard against silent month-overflow (e.g. Feb 30 → Mar 2).
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== m || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}
