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
import { pickHeroOccurrence } from "@/lib/series/occurrence-view";
import type { PlaceVenue } from "@/lib/seo/place-jsonld";

export interface LandingOccurrence {
  id: string;
  slug: string;
  name: string;
  startDate: Date | null;
  endDate: Date | null;
  /**
   * K46 (2026-06-26) — full venue, nested so it threads straight into the
   * EventSeries `subEvent[].location` (and the series-level location via the
   * hero occurrence). Null when the occurrence has no venue.
   */
  venue: PlaceVenue | null;
  /** OPE-27 — the occurrence's `events.image_url`, for series hero inheritance. */
  imageUrl: string | null;
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

  const rows = await db
    .select({
      id: events.id,
      slug: events.slug,
      name: events.name,
      startDate: events.startDate,
      endDate: events.endDate,
      imageUrl: events.imageUrl,
      venueName: venues.name,
      venueAddress: venues.address,
      venueCity: venues.city,
      venueState: venues.state,
      venueZip: venues.zip,
      venueLat: venues.latitude,
      venueLng: venues.longitude,
    })
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .where(and(eq(events.seriesId, series.id), isPublicEventStatus()));

  const occurrences: LandingOccurrence[] = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    startDate: r.startDate,
    endDate: r.endDate,
    imageUrl: r.imageUrl,
    // venueName is the leftJoin discriminator: null name ⇒ no venue row.
    venue: r.venueName
      ? {
          name: r.venueName,
          address: r.venueAddress,
          city: r.venueCity,
          state: r.venueState,
          zip: r.venueZip,
          latitude: r.venueLat,
          longitude: r.venueLng,
        }
      : null,
  }));

  // OPE-27 — read-time hero-image inheritance. The series landing's image
  // (og:image/twitter, the EventSeries JSON-LD, and the on-page hero) all read
  // `series.imageUrl`, which is commonly NULL because the P1 backfill seeds the
  // `event_series` row from an image-less member. When it's NULL, fall back to
  // the hero occurrence's own image so the landing reflects the same photo as
  // its occurrence — instead of og-default.png. A deliberately-set series image
  // still wins. Self-heals on the existing 300s ISR; no write-path propagation
  // or on-demand revalidation needed (the repo uses neither).
  const heroImageUrl = pickHeroOccurrence(occurrences, new Date())?.imageUrl ?? null;
  const effectiveImageUrl = series.imageUrl ?? heroImageUrl;

  return {
    series: {
      canonicalSlug: series.canonicalSlug,
      name: series.name,
      description: series.description,
      imageUrl: effectiveImageUrl,
    },
    occurrences,
  };
});
