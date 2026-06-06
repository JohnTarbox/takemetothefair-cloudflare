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

// ── Time-of-day extraction (event_days support) ─────────────────────
//
// Convention (mirrors src/lib/url-import/types.ts):
//   - Output is "HH:MM" 24-hour wall-clock-at-venue.
//   - No timezone is encoded. Conversion to UTC happens at render time
//     using parseWallClockInVenueZone with venue.timezone (P3b).
//   - Ambiguous input (e.g. bare "9" or "9-5" without AM/PM) returns
//     null so the caller can decide to skip event_days rather than
//     guess at AM/PM. Better to omit than to render the wrong hour.

const TIME_RE_12H = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*$/i;
const TIME_RE_24H = /^\s*(\d{1,2}):(\d{2})\s*$/;

/**
 * Parse one of: "9:00 AM", "9 AM", "9am", "09:00", "21:00" → "HH:MM" 24-hour.
 *
 * Returns `null` on:
 *  - Ambiguous input ("9", "9-5" — no AM/PM and not HH:MM)
 *  - Out-of-range hours (12-hour: must be 1-12; 24-hour: 0-23)
 *  - Invalid minutes (must be 0-59)
 *  - Non-string input
 */
export function parseTimeToHHMM(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const cleaned = text.trim();
  if (cleaned === "") return null;

  // Try 12-hour first (has explicit AM/PM marker).
  const m12 = cleaned.match(TIME_RE_12H);
  if (m12) {
    let h = parseInt(m12[1], 10);
    const min = m12[2] ? parseInt(m12[2], 10) : 0;
    const ampm = m12[3].toLowerCase();
    if (h < 1 || h > 12 || min < 0 || min > 59) return null;
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }

  // Then 24-hour HH:MM.
  const m24 = cleaned.match(TIME_RE_24H);
  if (m24) {
    const h = parseInt(m24[1], 10);
    const min = parseInt(m24[2], 10);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }

  return null;
}

/**
 * Parse a range like "9:00 AM - 5:00 PM", "9am-5pm", or
 * "9:00 AM – 5:00 PM" (en-dash) into `{openTime, closeTime}`.
 *
 * The right (end) side MUST be unambiguous — either explicit AM/PM or
 * HH:MM 24-hour. The left (start) side may be ambiguous bare digits and
 * inherit AM/PM from the right (e.g. "9-5pm" → 9 AM to 5 PM).
 *
 * Iterates over candidate matches in the input — important because a
 * string like "March 21 - March 23 — 10:00 AM - 5:00 PM" contains a
 * date-number range that LOOKS time-like to a naive regex. Skipping
 * candidates that can't be parsed lets the real time range win.
 *
 * Returns `null` on anything unparseable.
 */
export function parseTimeRange(text: unknown): { openTime: string; closeTime: string } | null {
  if (typeof text !== "string") return null;

  // Stage 1: both sides time-like (HH:MM or explicit am/pm). Rejects bare
  // numeric ranges like "21 - 23" entirely, so date-number ranges in
  // surrounding text don't shadow the real time range later in the string.
  // Token shape: \d{1,2}:\d{2}\s*(am|pm)? OR \d{1,2}\s*(am|pm).
  const strictToken = `(?:\\d{1,2}:\\d{2}\\s*(?:am|pm)?|\\d{1,2}\\s*(?:am|pm))`;
  const strictRe = new RegExp(`(${strictToken})\\s*[-–—]\\s*(${strictToken})`, "gi");
  for (const m of text.matchAll(strictRe)) {
    const openTime = parseTimeToHHMM(m[1].trim());
    const closeTime = parseTimeToHHMM(m[2].trim());
    if (openTime !== null && closeTime !== null) return { openTime, closeTime };
  }

  // Stage 2: inherit pattern — left is bare digits (no `:`, no am/pm),
  // right has explicit am/pm. Handles "9-5pm" idiom.
  const inheritRe = /(\d{1,2})\s*[-–—]\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))/gi;
  for (const m of text.matchAll(inheritRe)) {
    const left = m[1].trim();
    const right = m[2].trim();
    const closeTime = parseTimeToHHMM(right);
    if (closeTime === null) continue;
    const rightAmpm = right.match(/(am|pm)\s*$/i)?.[1]?.toLowerCase();
    if (!rightAmpm) continue;
    let openTime = parseTimeToHHMM(left + rightAmpm);
    if (openTime === null) continue;
    // For "9-5pm" — if both inherit PM and open >= close (impossible same-
    // day window), assume left was AM. e.g. "9-5pm" with PM-inherit gives
    // 21:00-17:00; flip left to AM → 09:00-17:00.
    if (rightAmpm === "pm") {
      const [oH] = openTime.split(":").map(Number);
      const [cH] = closeTime.split(":").map(Number);
      if (oH >= cH) {
        const reparsed = parseTimeToHHMM(left + "am");
        if (reparsed !== null) openTime = reparsed;
      }
    }
    return { openTime, closeTime };
  }

  return null;
}

/**
 * Generate one "YYYY-MM-DD" string per calendar day from start..end inclusive.
 * Both Dates are interpreted in UTC (matching the date-only storage
 * convention — startDate/endDate anchor at midnight UTC).
 *
 * Returns an empty array if start or end is not a valid Date, or end < start.
 */
export function expandDateRange(start: Date, end: Date): string[] {
  if (!(start instanceof Date) || isNaN(start.getTime())) return [];
  if (!(end instanceof Date) || isNaN(end.getTime())) return [];
  const startMs = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endMs = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  if (endMs < startMs) return [];
  const dayMs = 24 * 60 * 60 * 1000;
  const out: string[] = [];
  for (let t = startMs; t <= endMs; t += dayMs) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
