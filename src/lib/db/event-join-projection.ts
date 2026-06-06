/**
 * Narrow column projection for `events LEFT JOIN venues LEFT JOIN promoters`.
 *
 * Why this exists — 2026-06-04 incident
 * --------------------------------------
 * D1 caps result rows at 100 columns (SQLite's `SQLITE_MAX_COLUMN` default
 * is 2000; Cloudflare's runtime enforces a much tighter limit). The full
 * unfiltered three-way join produced rows with:
 *     events(62) + venues(27) + promoters(15) = 104 columns
 * which started failing every call to `getEvents()` / `getEvent()` with
 * `D1_ERROR: too many columns in result set: SQLITE_ERROR` after
 * `drizzle/0100_events_audience_access.sql` shipped (commit 0608771,
 * 2026-06-03 16:14 ET; deployed ~20:20 UTC).
 *
 * Symptom from the outside: `/events` and every `/events/<slug>` rendered
 * the catch-block empty state ("No events match your filters.") for ~16
 * hours / ~3,800 occurrences. The data was fine — the query was broken.
 *
 * The fix
 * -------
 * Project ONLY the venue+promoter columns that downstream consumers
 * actually access. Audited 2026-06-04 by greping `(venue|promoter)\??\.X`
 * across:
 *   - src/components/events/      (EventCard, EventsView, EventList, popover)
 *   - src/components/event-detail/
 *   - src/components/seo/         (EventSchema, ItemListSchema, etc.)
 *   - src/app/events/             (listing + [slug] + state/category pages)
 *
 * Result: events(62) + venue(10) + promoter(7) = 79 cols. 21 cols of
 * headroom against the 100-col cap. Future ALTERs on `events` can add up
 * to 21 columns before this projection has to be revisited.
 *
 * The maintenance contract
 * ------------------------
 * If a new event surface needs a venue/promoter field NOT in this list,
 * add it here AND wire the consumer in the SAME PR. D1 will silently
 * drop the row (the `try/catch` returns `[]`) if a future ALTER trips
 * the limit again — exactly the failure mode this projection repaired.
 *
 * The consumer type contract intentionally remains `Venue | null` /
 * `Promoter | null` (full row) in EventCard/EventsView. The cast happens
 * inside the producer (.map step) — see callers. This narrows the type
 * lie to one location per file, properly commented, with a verified
 * audit of what the consumers actually read.
 */

import { events, venues, promoters } from "@/lib/db/schema";

/** Use as the named-projection arg to `db.select(...)` when joining
 *  `events → venues` (no promoter). Result row shape:
 *    { events: Event, venue: VenueLite | null }
 *
 *  Mirrors the venue subset from `eventJoinProjection` but omits the
 *  promoter table — for surfaces that need event metadata + the venue's
 *  identity/location only (admin lists, dashboards, exports, listing
 *  filters, etc.). Sum: events(62) + venue(7) = 69 cols, 31 cols of
 *  headroom below D1's 100-col cap.
 *
 *  Added 2026-06-06 alongside PR #360 follow-up to clear 9 sites flagged
 *  WARN by `scripts/check-d1-100col-joins.ts` (events+venues = 92 cols,
 *  only 8 cols of headroom).
 */
export const eventVenueJoinProjection = {
  events: events,
  venue: {
    id: venues.id,
    name: venues.name,
    slug: venues.slug,
    address: venues.address,
    city: venues.city,
    state: venues.state,
    zip: venues.zip,
  },
} as const;

/** Use as the named-projection arg to `db.select(...)` when joining
 *  events → venues → promoters. Result row shape:
 *    { events: Event, venue: VenueLite | null, promoter: PromoterLite | null }
 *  (the leftJoins make `venue` and `promoter` nullable). */
export const eventJoinProjection = {
  events: events,
  venue: {
    id: venues.id,
    name: venues.name,
    slug: venues.slug,
    address: venues.address,
    city: venues.city,
    state: venues.state,
    zip: venues.zip,
    latitude: venues.latitude,
    longitude: venues.longitude,
    googleMapsUrl: venues.googleMapsUrl,
    // Cross-zone fields (drizzle/0112, P3a). Threaded into ICS export,
    // JSON-LD startDate offset, and the promoter wall-clock form (P3b).
    // Every existing venue defaults to America/New_York / en-US / US so
    // adding these is byte-identical render until a non-Eastern venue exists.
    timezone: venues.timezone,
    locale: venues.locale,
    country: venues.country,
  },
  promoter: {
    id: promoters.id,
    userId: promoters.userId,
    companyName: promoters.companyName,
    slug: promoters.slug,
    logoUrl: promoters.logoUrl,
    verified: promoters.verified,
    website: promoters.website,
  },
} as const;
