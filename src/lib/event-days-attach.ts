/**
 * Batch-fetch event_days dates for a list of events and attach them as
 * `eventDayDates: string[]` (sorted YYYY-MM-DD strings).
 *
 * Cohort 7 follow-up (analyst, 2026-06-01). Cohort 7's PR #295 added
 * `nextOccurrence()` (src/lib/event-occurrence.ts) and made `EventCard`
 * accept an optional `eventDayDates` prop, but every fetch site was
 * still passing `undefined` so the helper fell back to startDate — the
 * C2/U2 "MAY 16 / APR 19 on recurring events" bug stayed visible.
 *
 * This helper centralizes the JOIN + aggregation so each fetch site
 * adds ONE line (`events = await attachEventDayDates(db, events)`)
 * rather than rewriting its query with GROUP_CONCAT (which SQLite's
 * D1 supports awkwardly and which leaks across leftJoin chains).
 *
 * Performance characteristic: one extra SELECT per fetch call,
 * scoped to the page's already-loaded event ids. Batched in chunks of
 * 50 per [[feedback_d1_batch_param_limit]] (D1 caps statements at 100
 * bound params; inArray over 50 ids uses 50 params, well under).
 *
 * The empty-events fast-path returns immediately so home-page renders
 * with no upcoming events don't pay any cost.
 */

import { inArray } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { eventDays } from "@/lib/db/schema";

/**
 * Attach sorted `eventDayDates: string[]` to each event in the input
 * list. Events with no event_days rows get an empty array.
 */
export async function attachEventDayDates<E extends { id: string }>(
  db: Database,
  events: E[]
): Promise<Array<E & { eventDayDates: string[] }>> {
  if (events.length === 0) return [];

  const eventIds = events.map((e) => e.id);
  const dayMap = new Map<string, string[]>();

  const BATCH_SIZE = 50;
  for (let i = 0; i < eventIds.length; i += BATCH_SIZE) {
    const batch = eventIds.slice(i, i + BATCH_SIZE);
    const rows = await db
      .select({ eventId: eventDays.eventId, date: eventDays.date })
      .from(eventDays)
      .where(inArray(eventDays.eventId, batch));
    for (const r of rows) {
      const arr = dayMap.get(r.eventId) ?? [];
      arr.push(r.date);
      dayMap.set(r.eventId, arr);
    }
  }

  return events.map((e) => ({
    ...e,
    eventDayDates: (dayMap.get(e.id) ?? []).sort(),
  }));
}
