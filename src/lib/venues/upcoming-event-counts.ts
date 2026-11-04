/**
 * OPE-1573 — per-venue count of upcoming public events, as ONE grouped scan.
 *
 * The `/venues` listing and the venues CSV export used a correlated subquery
 * (`SELECT COUNT(*) FROM events WHERE events.venue_id = venues.id AND …`) per
 * venue row. On prod D1 the planner answers it from
 * `idx_events_status_effective_end`, not the venue index, so every one of the
 * 1,246 active venues re-scanned all upcoming APPROVED/TENTATIVE events:
 * ~707.7K rows read per page render. 184 renders in 12 minutes (the page is
 * `force-dynamic`) read 130.2M rows and were the top consumer in the
 * 2026-11-03 22:47Z "D1 DB is overloaded" outage (D1 GraphQL
 * `d1QueriesAdaptiveGroups`, 22:40–22:52Z).
 *
 * Counting once, grouped by venue, and LEFT JOINing the result reads ~4.4K
 * rows (measured read-only on prod; per-venue counts identical across all
 * 1,246 venues, 0 mismatches). It does not rely on an index name, so it is
 * safe on a fresh database whose index names differ from prod's.
 *
 * The filter is the same one both call sites used: public editorial status,
 * not cancelled / no-show, and the shared `upcomingEndPredicate`.
 */
import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { events, venues } from "@/lib/db/schema";
import { upcomingEndPredicate } from "@/lib/event-dates";
import type { getCloudflareDb } from "@/lib/cloudflare";

type Db = ReturnType<typeof getCloudflareDb>;

export function upcomingEventCountsByVenue(db: Db, now: Date) {
  return db
    .select({
      venueId: events.venueId,
      upcoming: sql<number>`COUNT(*)`.as("upcoming"),
    })
    .from(events)
    .where(
      and(
        isNotNull(events.venueId),
        inArray(events.status, ["APPROVED", "TENTATIVE"]),
        notInArray(events.lifecycleStatus, ["CANCELLED", "NO_SHOW"]),
        upcomingEndPredicate(now)
      )
    )
    .groupBy(events.venueId)
    .as("venue_upcoming_counts");
}

export type VenueUpcomingCounts = ReturnType<typeof upcomingEventCountsByVenue>;

/** The join condition, so both call sites spell it the same way. */
export function joinVenueCounts(counts: VenueUpcomingCounts) {
  return eq(counts.venueId, venues.id);
}

/** `event_count` for the select list: 0 for a venue with no upcoming events. */
export function venueEventCount(counts: VenueUpcomingCounts) {
  return sql<number>`COALESCE(${counts.upcoming}, 0)`;
}
