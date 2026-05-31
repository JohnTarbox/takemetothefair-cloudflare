/**
 * Deterministic extractor: parse month-day-range dates from cleaned text.
 * Catches the canonical "JUNE 19-20, 2026" / "August 2-10, 2026" / "Sept
 * 5–7" patterns that event pages put in <h1>/<h2> headings. The AI extractor
 * sometimes misses these on agenda-style layouts where the dates aren't
 * in a structured field; this regex pass is a cheap backstop.
 *
 * Surfaced by the Carolyn moose-lottery submission (inbound fe65fb77,
 * 2026-05-31): page header read "JUNE 19-20, 2026" and the AI returned
 * zero events. Regex over that line would have given us a usable date
 * range without an AI call.
 *
 * Design choices:
 *   - English month names only (full + 3-letter abbrev). Multilingual
 *     extraction is out of scope for K7 Tier 1.
 *   - Year is required by the canonical patterns (no inference). If the
 *     text says "June 19-20" with no year we skip — better to ask the
 *     reviewer than to guess.
 *   - Hyphens, en-dashes, em-dashes, and "to" all accepted as range
 *     separators.
 *   - Cross-month ranges ("June 28 – July 5, 2026") supported.
 *   - Returns the FIRST plausible date range found in the text. Multi-
 *     event pages are out of scope here (handled separately by the multi-
 *     event fan-out path).
 */

import type { ExtractedEventData } from "../types";

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const MONTH_NAMES = Object.keys(MONTHS).join("|");

// Same-month range: "June 19-20, 2026" / "JUNE 19 – 20, 2026" / "Jun 19 to 20 2026"
const SAME_MONTH_RE = new RegExp(
  `\\b(${MONTH_NAMES})\\s+(\\d{1,2})\\s*(?:-|–|—|to)\\s*(\\d{1,2})\\s*,?\\s*(\\d{4})\\b`,
  "i"
);

// Cross-month range: "June 28 - July 5, 2026" / "Jul 30 – Aug 2, 2026"
const CROSS_MONTH_RE = new RegExp(
  `\\b(${MONTH_NAMES})\\s+(\\d{1,2})\\s*(?:-|–|—|to)\\s*(${MONTH_NAMES})\\s+(\\d{1,2})\\s*,?\\s*(\\d{4})\\b`,
  "i"
);

// Single-day: "June 19, 2026" / "Aug 2 2026"
const SINGLE_DAY_RE = new RegExp(`\\b(${MONTH_NAMES})\\s+(\\d{1,2})\\s*,?\\s*(\\d{4})\\b`, "i");

/**
 * Find the first date range in cleaned text. Tries cross-month → same-month
 * → single-day in that order so multi-day events aren't truncated to single-
 * day. Returns null when no recognizable pattern is found.
 */
export function findDateRange(
  text: string
): Pick<ExtractedEventData, "startDate" | "endDate"> | null {
  // Cross-month must run before same-month because the same-month pattern
  // would over-match "June 28 - July 5, 2026" as "June 28-5, 2026" (no:
  // the regex requires both sides to be digits, but defense-in-depth).
  const cross = text.match(CROSS_MONTH_RE);
  if (cross) {
    const m1 = MONTHS[cross[1].toLowerCase()];
    const d1 = parseInt(cross[2], 10);
    const m2 = MONTHS[cross[3].toLowerCase()];
    const d2 = parseInt(cross[4], 10);
    const y = parseInt(cross[5], 10);
    const start = isoDate(y, m1, d1);
    const end = isoDate(y, m2, d2);
    if (start && end) return { startDate: start, endDate: end };
  }

  const same = text.match(SAME_MONTH_RE);
  if (same) {
    const m = MONTHS[same[1].toLowerCase()];
    const d1 = parseInt(same[2], 10);
    const d2 = parseInt(same[3], 10);
    const y = parseInt(same[4], 10);
    if (d2 >= d1) {
      const start = isoDate(y, m, d1);
      const end = isoDate(y, m, d2);
      if (start && end) return { startDate: start, endDate: end };
    }
  }

  const single = text.match(SINGLE_DAY_RE);
  if (single) {
    const m = MONTHS[single[1].toLowerCase()];
    const d = parseInt(single[2], 10);
    const y = parseInt(single[3], 10);
    const date = isoDate(y, m, d);
    if (date) return { startDate: date, endDate: date };
  }

  return null;
}

function isoDate(year: number, month: number, day: number): string | null {
  // Reject obviously impossible dates without pulling in a full calendar
  // library — Feb 31 etc. won't survive Date.UTC roundtrip.
  if (year < 1900 || year > 2200) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const t = Date.UTC(year, month - 1, day);
  const back = new Date(t);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() + 1 !== month ||
    back.getUTCDate() !== day
  ) {
    return null;
  }
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}
