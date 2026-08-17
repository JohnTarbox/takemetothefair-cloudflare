/**
 * OPE-396 — relative-time freshness labels for event cards.
 *
 * Every competitor card carries one ("Happening now", "In 2 days", "Season
 * over"). It reads fresh to a visitor and to a crawler, and it captures
 * "this weekend / happening now" intent that an absolute date does not.
 *
 * ── The reason ours can be better than theirs ───────────────────────────────
 * A relative label is a CLAIM about the world: "this is happening now" says a
 * person could drive there today. Competitors emit it from a single scraped
 * date. We hold `datesConfirmed` and per-day `event_days` rows, so we can tell
 * the difference between a date we verified and a date somebody typed into a
 * form — and the entire value of the label depends on us not spending that
 * distinction for a slightly punchier string.
 *
 * So the vocabulary splits in two:
 *
 *   confirmed    Happening now · Today · Tomorrow · This weekend · In N days
 *   unconfirmed  Expected today · Expected this weekend · Expected in N days
 *
 * `Happening now` has NO unconfirmed form. It is present tense and factual;
 * "expected happening now" is not a thing anyone says, and the honest version
 * of that claim is "Expected today". This is the acceptance criterion — no
 * "Happening now" on an unconfirmed event — and it is enforced by the type of
 * the vocabulary rather than by a check somebody has to remember.
 *
 * ── Weekend agreement is by construction ────────────────────────────────────
 * "This weekend" reuses `weekendWindow()` — the SAME function the
 * /events/[state]/this-weekend facet page filters on. A card claiming "This
 * weekend" that did not appear on the this-weekend page would be a visible
 * contradiction between two surfaces, and two independent definitions of "the
 * weekend" would drift the first time either was tuned.
 *
 * Everything here is pure and synchronous so the label server-renders inside
 * the card (crawlable, per the acceptance) with no client JS.
 */

import { weekendWindow } from "./facets";

export type RelativeTimeTone = "live" | "imminent" | "upcoming" | "past";

export interface RelativeTimeLabel {
  /** The rendered string, e.g. "Happening now" or "Expected in 3 days". */
  text: string;
  /** Drives styling. Not derived from the text — a caller matching on strings
   *  would break the moment the copy is edited. */
  tone: RelativeTimeTone;
  /** True when the underlying dates are unconfirmed and the wording is hedged.
   *  Exposed so a caller can add a tooltip without re-deriving it. */
  hedged: boolean;
}

export interface RelativeTimeInput {
  /** Public start date (already the publicStartDate ?? startDate the card uses). */
  startDate: Date | string | null | undefined;
  endDate: Date | string | null | undefined;
  /** `events.dates_confirmed`. Undefined is treated as UNCONFIRMED: an unknown
   *  provenance must never buy a confident label. */
  datesConfirmed?: boolean | null;
  /** Per-day dates when the caller joined event_days. When present these are
   *  authoritative for multi-day and discontinuous runs — a season-long market
   *  is not "happening now" on a Tuesday just because its range spans today. */
  eventDayDates?: (Date | string)[] | null;
}

/** How far ahead we still bother counting days. Past this the absolute date is
 *  more useful than "in 47 days", which conveys nothing a person can act on. */
export const MAX_DAYS_AHEAD = 30;

function toDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Midnight UTC of the day containing `d`. Every comparison here is day-grained:
 *  event dates are stored at noon UTC precisely so they mean a calendar day
 *  rather than an instant, and comparing instants would make "today" flip at
 *  the wrong moment for half the country. */
function startOfUTCDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function daysBetweenUTC(from: Date, to: Date): number {
  return Math.round((startOfUTCDay(to).getTime() - startOfUTCDay(from).getTime()) / 86_400_000);
}

/**
 * Build the label, or null when there is nothing honest to say (no usable
 * dates, or a date too far out to be meaningful).
 *
 * Returning null rather than a filler string is deliberate: a card with no
 * label reads as "no date information", which is true. A card labelled
 * "Upcoming" reads as information and carries none.
 */
export function relativeTimeLabel(
  input: RelativeTimeInput,
  now: Date = new Date()
): RelativeTimeLabel | null {
  const start = toDate(input.startDate);
  const end = toDate(input.endDate) ?? start;
  if (!start) return null;

  const confirmed = input.datesConfirmed === true;
  const today = startOfUTCDay(now);

  // event_days, when joined, override the range for "is it on today" — a
  // weekly market running May–October must not read "Happening now" on a
  // Wednesday. Without them we fall back to the contiguous range, which is the
  // pre-existing behaviour for the many callers that do not join days.
  const dayDates = (input.eventDayDates ?? [])
    .map(toDate)
    .filter((d): d is Date => d !== null)
    .map(startOfUTCDay);

  const lastDay =
    dayDates.length > 0
      ? new Date(Math.max(...dayDates.map((d) => d.getTime())))
      : end
        ? startOfUTCDay(end)
        : startOfUTCDay(start);

  // ── Ended ────────────────────────────────────────────────────────────────
  // Applies to confirmed and unconfirmed alike. The date we hold has passed;
  // that is true of our data either way, and the failure direction is safe —
  // nobody drives anywhere because of it.
  if (lastDay.getTime() < today.getTime()) {
    return { text: "Ended", tone: "past", hedged: false };
  }

  const onToday =
    dayDates.length > 0
      ? dayDates.some((d) => d.getTime() === today.getTime())
      : startOfUTCDay(start).getTime() <= today.getTime() && lastDay.getTime() >= today.getTime();

  if (onToday) {
    // The one label with no hedged form. An unconfirmed event that our data
    // says is on today gets "Expected today" — same information, no false
    // certainty that someone could act on and be let down by.
    if (!confirmed) return { text: "Expected today", tone: "imminent", hedged: true };
    // Multi-day and still running reads better as "Happening now"; a single day
    // reads better as "Today". Both are true; this picks the more useful one.
    const multiDay = dayDates.length > 1 || lastDay.getTime() > today.getTime();
    return multiDay
      ? { text: "Happening now", tone: "live", hedged: false }
      : { text: "Today", tone: "live", hedged: false };
  }

  // The next day this event actually runs — not simply its start, which for a
  // discontinuous series may be months behind us.
  const nextDay =
    dayDates.length > 0
      ? dayDates
          .filter((d) => d.getTime() >= today.getTime())
          .sort((a, b) => a.getTime() - b.getTime())[0]
      : startOfUTCDay(start);
  if (!nextDay) return null;

  const daysAway = daysBetweenUTC(today, nextDay);
  if (daysAway <= 0) return null; // defensive: handled by the onToday branch
  if (daysAway > MAX_DAYS_AHEAD) return null;

  const hedge = (assertive: string, expected: string): RelativeTimeLabel =>
    confirmed
      ? { text: assertive, tone: daysAway <= 3 ? "imminent" : "upcoming", hedged: false }
      : { text: expected, tone: daysAway <= 3 ? "imminent" : "upcoming", hedged: true };

  if (daysAway === 1) return hedge("Tomorrow", "Expected tomorrow");

  // "This weekend" only when the next running day falls inside the SAME window
  // the this-weekend facet page selects on. Checked before the day count so a
  // Thursday visitor sees "This weekend" rather than the flatter "In 2 days".
  const weekend = weekendWindow(now);
  if (nextDay.getTime() >= weekend.start.getTime() && nextDay.getTime() < weekend.end.getTime()) {
    return hedge("This weekend", "Expected this weekend");
  }

  return hedge(`In ${daysAway} days`, `Expected in ${daysAway} days`);
}
