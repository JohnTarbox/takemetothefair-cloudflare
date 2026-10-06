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
import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { events, eventVendors, eventSeries } from "@/lib/db/schema";
import { findDuplicate } from "@/lib/duplicates/find-duplicate";
import { normalizeName } from "@/lib/duplicates/normalize-name";
import {
  decideDiscoveryRouting,
  decideEditionPlacement,
  type EditionPlacement,
} from "@takemetothefair/utils";
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
  /** Resolved venue id of the incoming event — drives the cross-year series match. */
  venueId?: string | null;
  sourceUrl?: string | null;
  venueName?: string | null;
  venueAddress?: string | null;
  venueCity?: string | null;
  venueState?: string | null;
  actorUserId?: string | null;
}

export type RouteToOccurrenceResult =
  | { routed: false }
  /**
   * OPE-1327 — a submission to a MULTI-EDITION series that could not be placed
   * safely: its derived edition key is already held, or another edition starts
   * within ±7 days (the same edition again, or a dates-changed resubmission —
   * a human must say which). The caller inserts it as a reviewed standalone with
   * `possible_duplicate_of` = `nearEditionId`, never drops it.
   */
  | {
      routed: false;
      staged: "edition-ambiguous";
      seriesId: string;
      editionKey: string | null;
      nearEditionId: string | null;
    }
  | { routed: true; result: CreateOccurrenceResult };

/**
 * OPE-1327 — on a multi-edition series, where may an incoming edition go? The
 * rule is `decideEditionPlacement` (shared with MCP suggest_event); this only
 * loads the live members. Null when the series is annual (the caller keeps
 * today's year-bucketed path).
 */
async function placeInMultiEditionSeries(
  db: Db,
  seriesId: string,
  start: Date
): Promise<EditionPlacement | null> {
  const [series] = await db
    .select({ editionMode: eventSeries.editionMode })
    .from(eventSeries)
    .where(eq(eventSeries.id, seriesId))
    .limit(1);
  if (series?.editionMode !== "multi") return null;
  const members = await db
    .select({ id: events.id, startDate: events.startDate, editionKey: events.editionKey })
    .from(events)
    .where(
      and(eq(events.seriesId, seriesId), ne(events.status, "REJECTED"), isNull(events.mergedInto))
    );
  return decideEditionPlacement(members, start);
}

/**
 * Cross-year, DATE-WINDOW-FREE series match: find the unique series with an
 * occurrence at `venueId` whose (series OR member-event) name normalizes to the
 * incoming name. This is the piece findDuplicate can't do — its venue/name
 * stages are ±7-day-windowed, so a different-YEAR edition only matches when it
 * shares a `source_url` (exact_url). Returns the series id, or null when there's
 * no match or it's ambiguous (≥2 series — never guess).
 */
async function matchSeriesByNameVenue(
  db: Db,
  name: string,
  venueId: string
): Promise<string | null> {
  const norm = normalizeName(name);
  if (!norm) return null;

  const rows = await db
    .select({
      seriesId: events.seriesId,
      seriesName: eventSeries.name,
      eventName: events.name,
    })
    .from(events)
    .innerJoin(eventSeries, eq(events.seriesId, eventSeries.id))
    .where(and(eq(events.venueId, venueId), isNotNull(events.seriesId)));

  const matched = new Set<string>();
  for (const r of rows) {
    if (!r.seriesId) continue;
    if (normalizeName(r.seriesName) === norm || normalizeName(r.eventName) === norm) {
      matched.add(r.seriesId);
    }
  }
  // Unique match only — an ambiguous (≥2) match stays a standalone for an
  // operator to disambiguate rather than auto-attaching to the wrong series.
  return matched.size === 1 ? [...matched][0] : null;
}

export async function maybeRouteToOccurrence(
  db: Db,
  input: RouteToOccurrenceInput
): Promise<RouteToOccurrenceResult> {
  // No date → no year to bucket an occurrence into; leave to the standalone path.
  if (!input.startDate) return { routed: false };
  const incomingYear = input.startDate.getUTCFullYear();

  // 1) Cross-year series match by normalized-name + venue (no date window). This
  // catches different-YEAR editions findDuplicate misses (cheshire-fair-nh-2027
  // from a fresh source_url). createOccurrenceForSeries is year-bucketed
  // idempotent, so `created` (a new edition) AND `occurrence_exists` (the edition
  // already exists — don't mint a sibling) both mean "handled, skip standalone".
  if (input.name && input.venueId) {
    const seriesId = await matchSeriesByNameVenue(db, input.name, input.venueId);
    if (seriesId) {
      // OPE-1327 — a multi-edition series never answers "occurrence_exists" for
      // a same-year submission: that answer returned routed:true with NOTHING
      // written, and a second edition (October, after May) vanished silently.
      const placement = await placeInMultiEditionSeries(db, seriesId, input.startDate);
      if (placement?.kind === "stage") {
        return {
          routed: false,
          staged: "edition-ambiguous",
          seriesId,
          editionKey: placement.editionKey,
          nearEditionId: placement.nearEditionId,
        };
      }
      const result = await createOccurrenceForSeries(db, {
        seriesId,
        year: incomingYear,
        overrides: { startDate: input.startDate, endDate: input.endDate ?? null },
        actorUserId: input.actorUserId ?? null,
        sourceName: "discovery-occurrence",
        ingestionMethod: "community_suggestion",
        editionKey: placement?.editionKey ?? null,
      });
      if (result.created || (!placement && result.reason === "occurrence_exists")) {
        return { routed: true, result };
      }
      // series_not_found (race) / promoter_required → fall through to findDuplicate.
    }
  }

  // 2) findDuplicate fallback — exact_url cross-year + the matched-event routing.
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

  // OPE-1327 — on a multi-edition series a same-year match is not automatically
  // a duplicate: it may be the other edition. Place it with the same rule as
  // path 1, and stage it (never drop it) when the placement is ambiguous.
  const placement =
    matched.seriesId != null
      ? await placeInMultiEditionSeries(db, matched.seriesId, input.startDate)
      : null;
  if (placement?.kind === "stage") {
    return {
      routed: false,
      staged: "edition-ambiguous",
      seriesId: matched.seriesId!,
      editionKey: placement.editionKey,
      nearEditionId: placement.nearEditionId ?? dupe.existingEvent.id,
    };
  }
  if (placement?.kind === "create") {
    const result = await createOccurrenceForSeries(db, {
      seriesId: matched.seriesId!,
      year: incomingYear,
      overrides: { startDate: input.startDate, endDate: input.endDate ?? null },
      actorUserId: input.actorUserId ?? null,
      sourceName: "discovery-occurrence",
      ingestionMethod: "community_suggestion",
      editionKey: placement.editionKey,
    });
    if (result.created) return { routed: true, result };
    return { routed: false };
  }

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
