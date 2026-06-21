/**
 * Helpers for the public event-page display of recurring / multi-date
 * events (analyst 2026-05-22 P7b). The cadence-expander
 * (`src/lib/url-import/cadence-expander.ts`) goes phrase → dates at
 * ingest; this module goes dates → phrase + utility lookups for the
 * detail-page UI.
 *
 * The cadence phrase is intentionally conservative — we only emit a
 * named cadence when ALL intervals match the pattern. Anything mixed
 * falls back to the generic "Multiple dates" cue (caller can omit the
 * line altogether in that case if it prefers).
 */

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export type Cadence =
  | { kind: "weekly"; dayOfWeek: string }
  | { kind: "biweekly"; dayOfWeek: string }
  | { kind: "everyNDays"; days: number }
  | { kind: "monthly" }
  | { kind: "irregular" }
  | { kind: "single" };

function parseDateOnlyUTC(yyyymmdd: string): Date {
  // Anchor to noon UTC so day-of-week calculation is stable across all
  // US timezones (mirrors the project-wide pattern from event-dates.ts).
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

/** Infer cadence from a sorted (or unsorted) array of YYYY-MM-DD strings.
 *  Returns the most specific named cadence that holds across ALL intervals;
 *  falls back to "irregular" when intervals vary or "single" for one date. */
export function inferCadence(dates: ReadonlyArray<string>): Cadence {
  if (dates.length === 0) return { kind: "irregular" };
  if (dates.length === 1) return { kind: "single" };

  const sorted = [...dates].sort();
  const parsed = sorted.map(parseDateOnlyUTC);

  // All intervals in days
  const intervals: number[] = [];
  for (let i = 1; i < parsed.length; i++) {
    const ms = parsed[i].getTime() - parsed[i - 1].getTime();
    intervals.push(Math.round(ms / (24 * 60 * 60 * 1000)));
  }
  if (intervals.length === 0) return { kind: "irregular" };

  const allSame = intervals.every((d) => d === intervals[0]);
  const sameDayOfWeek = parsed.every((d) => d.getUTCDay() === parsed[0].getUTCDay());
  const dow = DAY_NAMES[parsed[0].getUTCDay()];

  if (allSame && intervals[0] === 7 && sameDayOfWeek) {
    return { kind: "weekly", dayOfWeek: dow };
  }
  if (allSame && intervals[0] === 14 && sameDayOfWeek) {
    return { kind: "biweekly", dayOfWeek: dow };
  }
  if (allSame && intervals[0] > 0) {
    return { kind: "everyNDays", days: intervals[0] };
  }
  // Monthly: 28-31 day intervals AND same calendar-day-of-month
  const sameDom = parsed.every((d) => d.getUTCDate() === parsed[0].getUTCDate());
  if (intervals.every((d) => d >= 28 && d <= 31) && sameDom) {
    return { kind: "monthly" };
  }
  return { kind: "irregular" };
}

/** Human-readable cadence label. Returns null for "single" so the caller
 *  can omit the line entirely when only one date is present. */
export function cadenceLabel(c: Cadence, count: number): string | null {
  switch (c.kind) {
    case "single":
      return null;
    case "weekly":
      return `Every ${c.dayOfWeek} — ${count} dates`;
    case "biweekly":
      return `Every other ${c.dayOfWeek} — ${count} dates`;
    case "everyNDays":
      return `Every ${c.days} days — ${count} dates`;
    case "monthly":
      return `Monthly — ${count} dates`;
    case "irregular":
      return `${count} dates`;
  }
}

/** Find the next upcoming YYYY-MM-DD relative to `now` (defaults to today,
 *  noon UTC). Returns null if every date is in the past. */
export function findNextUpcoming(
  dates: ReadonlyArray<string>,
  now: Date = new Date()
): string | null {
  // Compare against the START of today's UTC day, not the current instant, so
  // an occurrence on TODAY's calendar date still counts as upcoming. Without
  // this, a date stored at noon UTC (the parseDateOnlyUTC anchor) drops out of
  // "upcoming" at 12:00 UTC = 8am ET — i.e. an all-day event happening today
  // would read as past for most of its own day.
  const dayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const upcoming = dates
    .map((d) => ({ d, ms: parseDateOnlyUTC(d).getTime() }))
    .filter(({ ms }) => ms >= dayStartMs)
    .sort((a, b) => a.ms - b.ms);
  return upcoming[0]?.d ?? null;
}

/** True iff `discontinuousDates` is set on the event but no per-date
 *  event_days rows back it (the season-span case: a market that "runs
 *  every Saturday May–October" but is stored with just start/end and the
 *  discontinuous flag). The caller still wants a recurring / periodic cue
 *  rather than a bare multi-month range. */
export function isDiscontinuousWithoutDays(
  discontinuousDates: boolean | null | undefined,
  eventDaysCount: number
): boolean {
  return discontinuousDates === true && eventDaysCount === 0;
}
