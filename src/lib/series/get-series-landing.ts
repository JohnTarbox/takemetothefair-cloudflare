/**
 * EH3 P2.3 — series landing data fetch (React-cached).
 *
 * Resolves a slug to a series (by `event_series.canonical_slug`) plus its public
 * occurrences (the `events` with that `series_id`). Returns null when the slug is
 * not a series — the `/events/[slug]` page then falls through to event detail,
 * unchanged. Wrapped in React `cache()` so generateMetadata + the page share one
 * lookup per request.
 *
 * Until the gated P1 backfill creates series rows, this returns null for every
 * slug (empty `event_series` → indexed point-lookup miss), so the series branch
 * is inert and event pages behave exactly as today.
 */
import { cache } from "react";
import { eq, and } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { getCloudflareDb } from "@/lib/cloudflare";
import { eventSeries, events, venues } from "@/lib/db/schema";
import { isPublicEventStatus } from "@/lib/event-status";

export interface LandingOccurrence {
  id: string;
  slug: string;
  name: string;
  startDate: Date | null;
  endDate: Date | null;
  venueCity: string | null;
  venueState: string | null;
}

export interface SeriesLanding {
  series: {
    canonicalSlug: string;
    name: string;
    description: string | null;
    imageUrl: string | null;
  };
  occurrences: LandingOccurrence[];
}

export const getSeriesLanding = cache(async (slug: string): Promise<SeriesLanding | null> => {
  const db = getCloudflareDb();

  const [series] = await db
    .select({
      id: eventSeries.id,
      canonicalSlug: eventSeries.canonicalSlug,
      name: eventSeries.name,
      description: eventSeries.description,
      imageUrl: eventSeries.imageUrl,
    })
    .from(eventSeries)
    .where(eq(eventSeries.canonicalSlug, unsafeSlug(slug)))
    .limit(1);

  if (!series) return null;

  const occurrences = await db
    .select({
      id: events.id,
      slug: events.slug,
      name: events.name,
      startDate: events.startDate,
      endDate: events.endDate,
      venueCity: venues.city,
      venueState: venues.state,
    })
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .where(and(eq(events.seriesId, series.id), isPublicEventStatus()));

  return {
    series: {
      canonicalSlug: series.canonicalSlug,
      name: series.name,
      description: series.description,
      imageUrl: series.imageUrl,
    },
    occurrences,
  };
});
