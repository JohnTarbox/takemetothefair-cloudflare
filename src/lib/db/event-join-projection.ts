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
 * (OPE-1387: the events side is now the `publicEventColumns` allow-list, ~52
 * cols, so the headroom below is larger than stated and new events columns
 * no longer ride in at all unless allow-listed.)
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

/**
 * OPE-1387 — the PUBLIC allow-list of `events` columns.
 *
 * Before this, both projections below selected `events: events` (every
 * column). Consumers spread `...r.events` into "use client" components
 * (EventCard / EventsView / EventPopover) and public JSON, so every column —
 * `suggester_email`, `submitted_by_user_id`, `lifecycle_check_note`,
 * `gate_flags`, `merged_into`, … — was serialized into public page source and
 * the RSC payload.
 *
 * The rule: a column is here only if a PUBLIC surface (event card, listing
 * table/calendar, event detail page, JSON-LD, ICS/add-to-calendar, print
 * sheet, same-day JSON) reads it. Derived by narrowing the consumer prop types
 * to `PublicEvent` and letting `tsc` name every field they read.
 *
 * NEVER add: contact emails, user ids, operator/analyst notes, gate/flag
 * traces, dedup/merge pointers, sync/roster bookkeeping. Those are enforced by
 * `src/lib/db/__tests__/public-event-projection.test.ts` and the CI guard
 * `scripts/check-public-event-projection.ts`.
 *
 * Need a private column on an operator surface? Select it explicitly at that
 * (authenticated) call site — never widen this list.
 */
export const publicEventColumns = {
  id: events.id,
  name: events.name,
  slug: events.slug,
  description: events.description,
  promoterId: events.promoterId,
  venueId: events.venueId,
  stateCode: events.stateCode,
  isStatewide: events.isStatewide,
  startDate: events.startDate,
  endDate: events.endDate,
  publicStartDate: events.publicStartDate,
  publicEndDate: events.publicEndDate,
  datesConfirmed: events.datesConfirmed,
  recurrenceRule: events.recurrenceRule,
  categories: events.categories,
  tags: events.tags,
  ticketUrl: events.ticketUrl,
  ticketPriceMinCents: events.ticketPriceMinCents,
  ticketPriceMaxCents: events.ticketPriceMaxCents,
  imageUrl: events.imageUrl,
  imageFocalX: events.imageFocalX,
  imageFocalY: events.imageFocalY,
  featured: events.featured,
  // Rendered on the detail page ("N views").
  viewCount: events.viewCount,
  commercialVendorsAllowed: events.commercialVendorsAllowed,
  status: events.status,
  // The organizer's own event page (outbound CTA / "official site" link).
  sourceUrl: events.sourceUrl,
  discontinuousDates: events.discontinuousDates,
  vendorFeeMinCents: events.vendorFeeMinCents,
  vendorFeeMaxCents: events.vendorFeeMaxCents,
  vendorFeeNotes: events.vendorFeeNotes,
  indoorOutdoor: events.indoorOutdoor,
  petFriendly: events.petFriendly,
  estimatedAttendance: events.estimatedAttendance,
  eventScale: events.eventScale,
  applicationDeadline: events.applicationDeadline,
  applicationUrl: events.applicationUrl,
  applicationInstructions: events.applicationInstructions,
  walkInsAllowed: events.walkInsAllowed,
  seriesId: events.seriesId,
  editionKey: events.editionKey,
  lifecycleStatus: events.lifecycleStatus,
  previousStartDate: events.previousStartDate,
  previousEndDate: events.previousEndDate,
  primaryAudience: events.primaryAudience,
  publicAccess: events.publicAccess,
  // OPE-1151 — PUBLIC visitor copy by contract (private notes live in
  // event_internal_notes).
  accessNotes: events.accessNotes,
  registrationRequired: events.registrationRequired,
  createdAt: events.createdAt,
  updatedAt: events.updatedAt,
} as const;

type EventRow = typeof events.$inferSelect;

/** The event shape a public surface (and any "use client" component on one)
 *  may receive. A full `events` row is assignable to it, so prefer
 *  `toPublicEvent(row)` at the server→client boundary to strip the extras at
 *  RUNTIME — TypeScript's structural typing does not. */
export type PublicEvent = { [K in keyof typeof publicEventColumns]: EventRow[K] };

export const PUBLIC_EVENT_KEYS = Object.keys(publicEventColumns) as ReadonlyArray<
  keyof PublicEvent
>;

/** Copy ONLY the allow-listed columns off an events row (full or partial). */
export function toPublicEvent<T extends PublicEvent>(row: T): PublicEvent {
  const out = {} as Record<string, unknown>;
  for (const k of PUBLIC_EVENT_KEYS) out[k] = row[k];
  return out as PublicEvent;
}

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
  events: publicEventColumns,
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
  events: publicEventColumns,
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
    // OPE-1387 — NO `userId`: an account id never belongs on a public page.
    // Ownership checks select it server-side at the call site.
    companyName: promoters.companyName,
    slug: promoters.slug,
    logoUrl: promoters.logoUrl,
    verified: promoters.verified,
    website: promoters.website,
  },
} as const;
