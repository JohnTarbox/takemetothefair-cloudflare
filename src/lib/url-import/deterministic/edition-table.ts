/**
 * OPE-432 — recover the editions an organizer published, when extraction
 * flattened them to one year.
 *
 * ## The defect
 *
 * `marthasvineyardagriculturalsociety.org/the-fair` carries a four-year table:
 *
 *     Fair Dates for 2026-2029
 *     Thursday, August 13th to Sunday, August 16th, 2026
 *     Thursday, August 12th-Sunday, August 15th, 2027
 *     Thursday, August 10th-Sunday, August 13th, 2028
 *     Thursday, August 9th-Sunday, August 12th, 2029
 *
 * Extraction returned the right NUMBER of candidates and gave every one of
 * them 2026 or no year at all. Dedup then folded them together — correctly,
 * given identical input — and the submitter was told three editions we do not
 * have were "already in our directory".
 *
 * ## Why this is deterministic and not prompt work
 *
 * The previous attempt declined to fix this on the grounds that the flattening
 * happens inside the model's response, so it could only be addressed by prompt
 * changes that no unit test can pin. That is true of *making the model emit the
 * years*. It is not true of *recovering them*: a published date table is
 * machine-readable, and OPE-432's own grounding work (#906) already threads the
 * fetched source text into the parse path for exactly this kind of check.
 *
 * So this reads the source the model was given and repairs the omission
 * afterwards. The authority is the organizer's page, not the model.
 *
 * ## Why the existing date parser could not do it
 *
 * `date-regex.ts` says so itself: "Returns the FIRST plausible date range found
 * in the text. Multi-event pages are out of scope here (handled separately by
 * the multi-event fan-out path)." The fan-out path it defers to is the AI — the
 * thing that dropped the years. Each layer assumed the other covered this.
 *
 * Its patterns also cannot match these lines at all. `SAME_MONTH_RE` wants
 * `August 13 - 16, 2026`; the page writes ordinals and repeats the weekday and
 * month on both sides of the separator, so `13th to Sunday, August 16th` never
 * matches. That is why this module has its own tolerant pattern rather than
 * reusing `findDateRange`.
 */

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

/** `Thursday,` / `Thu.` / `Thurs` — optional, and discarded when present. */
const WEEKDAY = `(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?\\.?\\s*,?\\s*`;

/** `13th` / `1st` / `22nd` — the ordinal suffix is optional and ignored. */
const DAY = `(\\d{1,2})(?:st|nd|rd|th)?`;

const SEP = `\\s*(?:-|–|—|to|through|thru|until)\\s*`;

/**
 * One published edition: `[weekday,] Month D[th] <sep> [weekday,] [Month] D[th], YYYY`.
 *
 * The closing month is optional so a same-month range that writes the month
 * once ("August 13th to 16th, 2026") parses the same as one that repeats it.
 * The year is REQUIRED and appears once, at the end — which is what makes this
 * safe to run over arbitrary page text: a line without an explicit year is not
 * an edition row, and guessing one is the failure mode this whole ticket is
 * about.
 */
const EDITION_RE = new RegExp(
  `(?:${WEEKDAY})?(${MONTH_NAMES})\\s+${DAY}` +
    SEP +
    `(?:${WEEKDAY})?(?:(${MONTH_NAMES})\\s+)?${DAY}` +
    `\\s*,?\\s*(\\d{4})`,
  "gi"
);

export interface EditionDates {
  /** ISO `YYYY-MM-DD`. */
  startDate: string;
  /** ISO `YYYY-MM-DD`. Equal to `startDate` for a single-day edition. */
  endDate: string;
  /** Calendar year of `startDate`. The dimension that was being lost. */
  year: number;
}

function isoDate(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2200) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const back = new Date(Date.UTC(year, month - 1, day));
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() + 1 !== month ||
    back.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Every explicitly-dated range in `text`, in the order it appears, deduplicated
 * by `startDate`.
 *
 * Deliberately NOT "the first one" — that is `findDateRange`'s job and the
 * reason the multi-edition case had no owner.
 */
export function findEditionDates(text: string): EditionDates[] {
  if (!text) return [];

  const out: EditionDates[] = [];
  const seen = new Set<string>();

  // `matchAll` on a fresh regex each call — a module-level /g regex carries
  // `lastIndex` between calls and would silently skip matches on the second
  // invocation.
  for (const m of text.matchAll(new RegExp(EDITION_RE.source, "gi"))) {
    const startMonth = MONTHS[m[1].toLowerCase()];
    const startDay = parseInt(m[2], 10);
    // Absent closing month ⇒ the range stays within the opening month.
    const endMonth = m[3] ? MONTHS[m[3].toLowerCase()] : startMonth;
    const endDay = parseInt(m[4], 10);
    const year = parseInt(m[5], 10);

    const startDate = isoDate(year, startMonth, startDay);
    const endDate = isoDate(year, endMonth, endDay);
    if (!startDate || !endDate) continue;

    // A range that appears to run backwards is a cross-year wrap
    // ("December 30 - January 2, 2027" prints the END year). Roll the start
    // back rather than emitting an inverted range.
    if (endDate < startDate) {
      const rolled = isoDate(year - 1, startMonth, startDay);
      if (!rolled) continue;
      if (seen.has(rolled)) continue;
      seen.add(rolled);
      out.push({ startDate: rolled, endDate, year: year - 1 });
      continue;
    }

    if (seen.has(startDate)) continue;
    seen.add(startDate);
    out.push({ startDate, endDate, year });
  }

  return out;
}

/**
 * The editions a page publishes for ONE recurring event, or `[]` when the page
 * is not that shape.
 *
 * Requires at least `minYears` DISTINCT years. One dated range is an ordinary
 * event page and needs no repair; two or more is the "we publish three years
 * forward" pattern this exists for.
 *
 * Returns at most one edition per year — the earliest. A fair that also lists
 * an unrelated winter market in the same year must not turn that into a second
 * edition of itself, and picking per year keeps the result to "the annual
 * edition", which is the only claim the table supports.
 */
export function findPublishedEditions(text: string, minYears = 2): EditionDates[] {
  const all = findEditionDates(text);

  const byYear = new Map<number, EditionDates>();
  for (const e of all) {
    const existing = byYear.get(e.year);
    if (!existing || e.startDate < existing.startDate) byYear.set(e.year, e);
  }

  if (byYear.size < minYears) return [];
  return [...byYear.values()].sort((a, b) => a.startDate.localeCompare(b.startDate));
}
