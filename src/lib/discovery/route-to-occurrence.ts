/**
 * EH3 P3.3b / K34 (2026-06-26) — discovery match-to-series routing for the
 * community-suggestion ingest path.
 *
 * Before a community/discovery submission inserts a year-suffixed STANDALONE
 * event (the `cheshire-fair-nh-2027` class — a TENTATIVE sibling alongside the
 * canonical `cheshire-fair`), check whether it's really a new EDITION of an
 * existing seriesed event. If so, attach it as an occurrence under that series
 * (`/events/<series>/<year>`) instead of a sibling slug.
 *
 * The decision is the shared, unit-tested `decideDiscoveryRouting` (same one the
 * vendor `suggest_event` path uses). INERT until the EH3 P1 backfill sets
 * `series_id` on existing events: until then a findDuplicate hit (if any) has no
 * series, so the routing returns `stage`/`duplicate`/`create_new` and this
 * returns `{ routed: false }` — the caller falls through to its standalone
 * insert, behaviour unchanged. The only live effect pre-backfill is the
 * read-only findDuplicate query.
 */
import { eq, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { events, eventVendors } from "@/lib/db/schema";
import { findDuplicate } from "@/lib/duplicates/find-duplicate";
import { decideDiscoveryRouting } from "@takemetothefair/utils";
import {
  createOccurrenceForSeries,
  type CreateOccurrenceResult,
} from "@/lib/series/create-occurrence";

type Db = Database;

export interface RouteToOccurrenceInput {
  name?: string | null;
  /** Incoming start date — the edition year is derived from it (UTC). */
  startDate: Date | null;
  endDate?: Date | null;
  sourceUrl?: string | null;
  venueName?: string | null;
  venueAddress?: string | null;
  venueCity?: string | null;
  venueState?: string | null;
  actorUserId?: string | null;
}

export type RouteToOccurrenceResult =
  | { routed: false }
  | { routed: true; result: CreateOccurrenceResult };

export async function maybeRouteToOccurrence(
  db: Db,
  input: RouteToOccurrenceInput
): Promise<RouteToOccurrenceResult> {
  // No date → no year to bucket an occurrence into; leave to the standalone path.
  if (!input.startDate) return { routed: false };
  const incomingYear = input.startDate.getUTCFullYear();

  const dupe = await findDuplicate(db, {
    sourceUrl: input.sourceUrl ?? null,
    name: input.name ?? null,
    startDate: input.startDate.toISOString().slice(0, 10),
    venueName: input.venueName ?? null,
    venueAddress: input.venueAddress ?? null,
    venueCity: input.venueCity ?? null,
    venueState: input.venueState ?? null,
  });
  if (!dupe.isDuplicate) return { routed: false };

  const [matched] = await db
    .select({
      seriesId: events.seriesId,
      startDate: events.startDate,
      rolledFromEventId: events.rolledFromEventId,
    })
    .from(events)
    .where(eq(events.id, dupe.existingEvent.id))
    .limit(1);
  if (!matched) return { routed: false };

  const [vc] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(eventVendors)
    .where(eq(eventVendors.eventId, dupe.existingEvent.id));

  const routing = decideDiscoveryRouting({
    matched: true,
    existingSeriesId: matched.seriesId ?? null,
    existingYear: matched.startDate ? new Date(matched.startDate).getUTCFullYear() : null,
    existingVendorBearing: (vc?.n ?? 0) > 0,
    existingRolledEdition: matched.rolledFromEventId != null,
    incomingYear,
  });

  // Only the "occurrence" verdict re-routes; everything else (duplicate / stage /
  // create_new) keeps the caller's standalone behaviour.
  if (routing.action !== "occurrence") return { routed: false };

  const result = await createOccurrenceForSeries(db, {
    seriesId: routing.seriesId,
    year: routing.year,
    overrides: { startDate: input.startDate, endDate: input.endDate ?? null },
    actorUserId: input.actorUserId ?? null,
    sourceName: "discovery-occurrence",
    ingestionMethod: "community_suggestion",
  });
  return { routed: true, result };
}
