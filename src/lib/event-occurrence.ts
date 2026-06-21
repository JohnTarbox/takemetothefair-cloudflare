/**
 * Event-shape-aware "next occurrence" resolver. The site treats some
 * events as multi-day spans (a 5-day fair), some as discontinuous
 * date lists (a Saturday market), and some as recurrence rules
 * (RRULE). Display surfaces — date badges, calendar chips, ICS
 * exports, "this weekend" filters — all need the SAME view of "what
 * date represents this event NOW" so users don't see the series
 * start date in May when the next occurrence is in July.
 *
 * Cohort 7 (analyst, 2026-06-01) — extracted to fix C2/U2 (date
 * badges showing series start) and feed C1 (ICS) + C4 (calendar
 * chip flooding). Wraps the existing `findNextUpcoming` from
 * src/lib/recurring-display.ts as the date-list primitive.
 *
 * Resolution order (first hit wins):
 *   1. Event has populated event_days → return the next future
 *      occurrence's date (or the most recent past occurrence if
 *      all are past).
 *   2. Event has `recurrenceRule` populated (rare today —
 *      1/942 events per analyst spec — but the path needs to exist
 *      for C1's ICS RRULE emission).
 *   3. Event has discontinuous_dates=true but no event_days
 *      (Farmington farmers-market shape — data-quality gap per
 *      PR #275). Flagged via `isDataQualityGap=true` so the caller
 *      can show a "see schedule" link rather than a bare wrong
 *      date. Falls back to startDate for the display value.
 *   4. Event is in progress (startDate <= today <= endDate):
 *      return today (isOngoing=true), so badges show "Today" /
 *      "Now showing" rather than the start date 3 days ago.
 *   5. Event is in the future: return startDate.
 *   6. Event is past: return null (caller decides whether to
 *      surface the past date or hide).
 */

import { findNextUpcoming } from "@/lib/recurring-display";

export interface EventLike {
  startDate: Date | string | null;
  endDate: Date | string | null;
  /** True when the event has non-contiguous dates (markets that run
   *  certain weekends, not every day). Distinct from a multi-day
   *  range where start/end bracket a contiguous block. */
  discontinuousDates: boolean | null;
  /** YYYY-MM-DD strings, optionally sorted (we re-sort defensively).
   *  Populated for events with explicit per-day rows in event_days. */
  eventDayDates?: string[];
  /** iCal RRULE string (RFC 5545). Optional column on events. Rare
   *  in production but feeds C1 ICS export. */
  recurrenceRule?: string | null;
}

export interface NextOccurrence {
  /** Date to display in badges / sort by / pass to ICS DTSTART. */
  date: Date;
  /** True when start <= today <= end (multi-day event currently in
   *  progress). Caller can show "Today" / "Now showing" instead of
   *  the start date. */
  isOngoing: boolean;
  /** True when end > start by ≥ 1 day AND no event_days backs it
   *  (i.e. a single contiguous multi-day event, not a series of
   *  discrete occurrences). Drives C4's calendar-chip rendering
   *  decision (span chip vs flooding every cell). */
  isContinuousMultiDay: boolean;
  /** True when the event flagged itself as discontinuous but has
   *  no event_days to back it up — the display path can't compute
   *  a true next-occurrence, so it falls back to startDate. Caller
   *  should consider showing a "see schedule" affordance. */
  isDataQualityGap: boolean;
  /** Total span in whole days inclusive (1 for a single-day event).
   *  Useful for the calendar's spanning-bar width. */
  totalSpanDays: number;
  /** True when `date` is TODAY (UTC calendar day). Lets cards render
   *  "Today" instead of "Next: <today's date>" for an event happening now. */
  isToday: boolean;
  /** True when the event is a discrete recurring SERIES — its event_days have
   *  gaps (a weekly/seasonal market, a weekends-only faire), as opposed to a
   *  single contiguous run (a 3-day fair). Drives the card's "Next: …"/"Today"
   *  vs. season-range decision. False for single/contiguous events and for
   *  events with no event_days. Independent of whether the series has started. */
  isRecurringSeries: boolean;
}

function toDate(value: Date | string | null): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function dayDiffInclusive(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

function ymdToDate(yyyymmdd: string): Date {
  // Mirror src/lib/recurring-display.ts:parseDateOnlyUTC — anchor at
  // noon UTC so day-of-week is stable across US timezones.
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

/**
 * Resolve the "right now" date for an event. Returns null only when
 * the event has nothing useful to show (past, no event_days, no
 * future occurrences). Most callers should fall back to event.startDate
 * in that case rather than skipping the row.
 */
export function nextOccurrence(event: EventLike, now: Date = new Date()): NextOccurrence | null {
  const start = toDate(event.startDate);
  const end = toDate(event.endDate) ?? start;

  // "Today counts as present": compare by CALENDAR DAY, not the current instant,
  // so an all-day event happening TODAY doesn't flip to "past" at noon UTC
  // (8am ET). dayStart = midnight UTC of today; sameUTCDay flags occurrences on
  // today's date so cards can render "Today".
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 86_400_000 - 1);
  const sameUTCDay = (d: Date): boolean =>
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate();

  // Path 1 — explicit per-day rows. Authoritative when populated.
  if (event.eventDayDates && event.eventDayDates.length > 0) {
    const upcoming = findNextUpcoming(event.eventDayDates, now);
    if (upcoming) {
      const date = ymdToDate(upcoming);
      // Synthesize a span for the calendar-chip path: first-to-last
      // event_day. Useful for calendar UIs that want to know the
      // outer envelope without re-sorting in the consumer.
      const sortedDays = [...event.eventDayDates].sort();
      const firstDay = ymdToDate(sortedDays[0]);
      const lastDay = ymdToDate(sortedDays[sortedDays.length - 1]);
      // A discrete recurring series has a gap (> 1 day) between some pair of
      // consecutive occurrences (weekly market, weekends-only faire). A single
      // contiguous run (a 3-day fair listed day-by-day) has none. This — NOT
      // "occurrence is after the start" — is what distinguishes a series, so a
      // not-yet-started weekly market still shows "Next: <first market day>".
      let hasGap = false;
      for (let i = 1; i < sortedDays.length; i++) {
        const prevMs = ymdToDate(sortedDays[i - 1]).getTime();
        const curMs = ymdToDate(sortedDays[i]).getTime();
        if (Math.round((curMs - prevMs) / 86_400_000) > 1) {
          hasGap = true;
          break;
        }
      }
      return {
        date,
        isOngoing: false, // per-occurrence — "ongoing" doesn't apply
        isContinuousMultiDay: false,
        isDataQualityGap: false,
        totalSpanDays: dayDiffInclusive(firstDay, lastDay),
        isToday: sameUTCDay(date),
        isRecurringSeries: hasGap,
      };
    }
    // All event_days are past — fall through to the date-range path,
    // which will return null for past events.
  }

  if (!start) return null;

  // Path 2 — discontinuous flagged but no event_days. Data-quality
  // gap. Return the startDate as a best-effort but flag it so the
  // caller can suppress misleading badges.
  if (event.discontinuousDates && (!event.eventDayDates || event.eventDayDates.length === 0)) {
    if (end && dayStart > end) return null; // ended before today
    return {
      date: start,
      isOngoing: !!end && dayEnd >= start && dayStart <= end,
      isContinuousMultiDay: false,
      isDataQualityGap: true,
      totalSpanDays: end ? dayDiffInclusive(start, end) : 1,
      isToday: sameUTCDay(start),
      isRecurringSeries: false,
    };
  }

  // Path 3 — contiguous multi-day or single-day. The common case.
  // Use calendar-day bounds so an event whose last day is TODAY still reads as
  // in-progress (not past) after noon UTC.
  if (end && dayEnd >= start && dayStart <= end) {
    // Event is running now (by calendar day). Return today (anchored to noon
    // UTC) so badges read "Today" rather than the start date in the past.
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
    return {
      date: today,
      isOngoing: true,
      isContinuousMultiDay: dayDiffInclusive(start, end) > 1,
      isDataQualityGap: false,
      totalSpanDays: dayDiffInclusive(start, end),
      isToday: true,
      isRecurringSeries: false,
    };
  }

  if (dayStart < start) {
    return {
      date: start,
      isOngoing: false,
      isContinuousMultiDay: !!end && dayDiffInclusive(start, end) > 1,
      isDataQualityGap: false,
      totalSpanDays: end ? dayDiffInclusive(start, end) : 1,
      isToday: sameUTCDay(start),
      isRecurringSeries: false,
    };
  }

  // Past event with no future occurrences. Caller decides whether
  // to fall back to startDate.
  return null;
}

/**
 * Convenience: returns the date the display layer should use, with
 * a sensible fallback to startDate when nextOccurrence returns null.
 * Most card components want this signature rather than the full
 * NextOccurrence struct.
 */
export function displayDate(event: EventLike, now: Date = new Date()): Date | null {
  const occ = nextOccurrence(event, now);
  if (occ) return occ.date;
  return toDate(event.startDate);
}

/**
 * Should a card show "Next: <occurrence.date>" / "Today" instead of the full
 * season range? True iff the event is a discrete recurring SERIES (its
 * event_days have gaps — a weekly market, a weekends-only faire). This is
 * structural, NOT "the next occurrence is after the start", so a not-yet-started
 * weekly market (first market day = the start) still shows "Next: <first day>"
 * rather than a months-long range. Single-day and contiguous multi-day events
 * (a 3-day fair) and events with no event_days return false → keep their range.
 *
 * (Revised 2026-06-21 — the prior `occurrence.date > start` heuristic wrongly
 * excluded future-starting markets, which then rendered season ranges.)
 */
export function showsNextOccurrence(occurrence: NextOccurrence | null): boolean {
  return !!occurrence && occurrence.isRecurringSeries;
}
