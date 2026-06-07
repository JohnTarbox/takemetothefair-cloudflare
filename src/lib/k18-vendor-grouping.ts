/**
 * F — K18 Phase 2 (2026-06-06): per-occurrence vendor grouping helpers.
 *
 * Shared between the event detail page render and the JSON-LD subEvent
 * emitter so the grouping semantics are computed exactly once and the
 * surfaces can't drift.
 *
 * Semantics (must match the contract documented at packages/db-schema/
 * src/index.ts:eventVendors and drizzle/0114):
 *   - vendor.event_day_id IS NULL  -> series-wide / regular participant
 *     (applies to every occurrence; appears under "Regular participants"
 *     when ANY per-day link exists, or under no heading at all when the
 *     entire lineup is series-wide -- preserves pre-K18 render).
 *   - vendor.event_day_id IS NOT NULL -> vendor on that specific date only.
 *     Appears under the date heading; NOT under "Regular participants".
 *
 * For events with a single event_day (or zero -- a one-shot non-recurring
 * event), grouping headings are suppressed since there's no meaningful
 * "regular vs special occurrence" distinction.
 */

/** Date string in YYYY-MM-DD format -- matches event_days.date. */
type DayDate = string;

/** Format a YYYY-MM-DD venue-local date string for display as a section
 *  heading ("Friday, July 3"). Manual parsing avoids the UTC-midnight
 *  vs. local-day drift that new Date("2026-07-03") produces in
 *  negative-offset timezones. */
export function formatOccurrenceDate(dateString: DayDate): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
  if (!m) return dateString;
  const year = Number(m[1]);
  const monthIdx = Number(m[2]) - 1;
  const day = Number(m[3]);
  const d = new Date(year, monthIdx, day);
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/** Minimal row shape needed for grouping. Any caller's row type that has
 *  eventDayId works (vendor profile uses a different shape; the helper
 *  accepts both via this structural type). */
interface VendorRowLike {
  eventDayId?: string | null;
}

/** Group key: null = series-wide; string = event_day_id. */
type GroupKey = string | null;

export interface VendorGroup<T> {
  /** Stable key for React `key` props. "series-wide" for NULL, the
   *  event_day_id for per-day. */
  key: string;
  /** The eventDayId this group represents, or null for series-wide. */
  eventDayId: GroupKey;
  /** Resolved YYYY-MM-DD date string for per-day groups; null for series-wide. */
  date: DayDate | null;
  /** Display heading text; empty string means "render without heading"
   *  (used when grouping is suppressed). */
  heading: string;
  /** Vendors in this group, in caller-supplied order. */
  vendors: T[];
}

/**
 * Group a vendor list by event_day_id with K18 semantics. Returns one
 * VendorGroup per distinct occurrence in the lineup.
 *
 * @param vendors       -- the filtered vendor list (e.g. all exhibitors,
 *                        or all sponsors). Each row must have eventDayId.
 * @param eventDays     -- the event's event_days rows; sourced from the
 *                        page-level query. Used to resolve eventDayId
 *                        -> date string for headings + chronological sort.
 * @param suppressIfFlat -- when true (default), if the lineup is entirely
 *                        series-wide (no per-day links) OR the event has
 *                        <= 1 event_day, return a single un-headinged group.
 *                        Set false to always emit a "Regular participants"
 *                        heading even on degenerate events (e.g. when the
 *                        caller wants visible headings for stylistic
 *                        consistency).
 */
export function groupVendorsByDay<T extends VendorRowLike>(
  vendors: T[],
  eventDays: Array<{ id?: string | null; date: DayDate }>,
  suppressIfFlat = true
): VendorGroup<T>[] {
  if (vendors.length === 0) return [];

  // Build eventDayId -> date lookup. Days with no id (shouldn't happen in
  // post-K18 data but defensive) get filtered out -- they can't be matched.
  const dateById = new Map<string, DayDate>();
  for (const d of eventDays) {
    if (d.id) dateById.set(d.id, d.date);
  }

  // Partition vendors into series-wide and per-day buckets.
  const seriesWide: T[] = [];
  const byDay = new Map<string, T[]>();
  for (const v of vendors) {
    if (v.eventDayId == null) {
      seriesWide.push(v);
    } else {
      const arr = byDay.get(v.eventDayId) ?? [];
      arr.push(v);
      byDay.set(v.eventDayId, arr);
    }
  }

  // Suppress headings when the lineup is purely series-wide AND the event
  // doesn't have multiple days to distinguish. This preserves the exact
  // pre-K18 render for events that haven't adopted per-day scoping.
  const allSeriesWide = byDay.size === 0;
  if (suppressIfFlat && allSeriesWide && eventDays.length <= 1) {
    return [
      {
        key: "flat",
        eventDayId: null,
        date: null,
        heading: "",
        vendors: seriesWide,
      },
    ];
  }

  // Build groups: "Regular participants" first when any series-wide
  // vendors exist, then per-day groups sorted chronologically.
  const groups: VendorGroup<T>[] = [];
  if (seriesWide.length > 0) {
    groups.push({
      key: "series-wide",
      eventDayId: null,
      date: null,
      heading: "Regular participants",
      vendors: seriesWide,
    });
  }
  const perDayEntries = [...byDay.entries()]
    .map(([dayId, vs]) => ({
      dayId,
      date: dateById.get(dayId) ?? null,
      vendors: vs,
    }))
    // Per-day groups sort chronologically; days with missing resolved date
    // (orphaned event_day_id -- would indicate a bug) sink to the end.
    .sort((a, b) => {
      if (a.date == null && b.date == null) return 0;
      if (a.date == null) return 1;
      if (b.date == null) return -1;
      return a.date.localeCompare(b.date);
    });
  for (const entry of perDayEntries) {
    groups.push({
      key: entry.dayId,
      eventDayId: entry.dayId,
      date: entry.date,
      heading: entry.date ? formatOccurrenceDate(entry.date) : "Specific occurrence",
      vendors: entry.vendors,
    });
  }
  return groups;
}
