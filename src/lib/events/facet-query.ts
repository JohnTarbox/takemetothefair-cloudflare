/**
 * OPE-395 — the one query path for facet pages.
 *
 * Both the rendered page and the sitemap ask "how many events does this facet
 * have?", and they MUST get the same answer from the same code. If the sitemap
 * used a cheaper approximation it would eventually list a URL the page had
 * marked `noindex` — a page that asks not to be indexed while the sitemap asks
 * for it to be, which is the kind of contradictory signal GSC reports and
 * nobody notices for months. Sharing `facetConditions` makes the two agree by
 * construction rather than by discipline (`feedback_classifier_window_must_match_display`).
 */
import { and, count, eq, isNotNull, inArray, sql } from "drizzle-orm";
import { events, venues, promoters, eventVendors, vendors } from "@/lib/db/schema";
import { isPublicEventStatus } from "@/lib/event-status";
import { upcomingEndPredicate } from "@/lib/event-dates";
import { isPubliclyVisibleVendorLink } from "@/lib/vendor-status";
import { attachEventDayDates } from "@/lib/event-days-attach";
import { eventJoinProjection } from "@/lib/db/event-join-projection";
import {
  facetConditions,
  resolveFacet,
  isFacetIndexable,
  allFacetSlugs,
  facetUrl,
  FACET_STATES,
  type ResolvedFacet,
} from "@/lib/events/facets";
import { STATE_BY_SLUG } from "@/lib/states";
import type { getCloudflareDb } from "@/lib/cloudflare";

/**
 * The concrete Drizzle/D1 handle. Typed rather than `any` on purpose: with
 * `any` the row inference collapses, `attachEventDayDates` degrades to
 * `{ id: string }`, and the projection silently stops being checked — which is
 * exactly how two narrow-projection breaks slipped through in OPE-403.
 */
type FacetDb = ReturnType<typeof getCloudflareDb>;

/**
 * The predicates every facet page shares: publicly visible, dated, and not yet
 * over. Identical to the state page's own filter, so a facet is always a strict
 * subset of its state — a facet can never surface an event the state page hides.
 */
function baseConditions(stateCode: string, now: Date) {
  return [
    isPublicEventStatus(),
    eq(events.stateCode, stateCode),
    isNotNull(events.startDate),
    upcomingEndPredicate(now),
  ];
}

/**
 * Count the events on a facet.
 *
 * Joins `venues` unconditionally even though only region facets read the city:
 * a LEFT JOIN cannot change the row count, and keeping one shape means the
 * count query and the listing query cannot diverge on which events they see.
 */
export async function countFacetEvents(
  db: FacetDb,
  stateCode: string,
  stateSlug: string,
  facet: ResolvedFacet,
  now: Date
): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .where(and(...baseConditions(stateCode, now), ...facetConditions(stateSlug, facet, now)));
  return rows[0]?.n ?? 0;
}

/**
 * One page of events for a facet, shaped exactly like the state page's rows so
 * `EventsView` renders them with no special-casing.
 */
export async function getFacetEvents(
  db: FacetDb,
  stateCode: string,
  stateSlug: string,
  facet: ResolvedFacet,
  now: Date,
  page: number,
  limit: number
) {
  const offset = (page - 1) * limit;
  const conditions = [...baseConditions(stateCode, now), ...facetConditions(stateSlug, facet, now)];

  // Narrow projection — D1 caps a result at 100 columns; see eventJoinProjection.
  const results = await db
    .select(eventJoinProjection)
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .leftJoin(promoters, eq(events.promoterId, promoters.id))
    .where(and(...conditions))
    .orderBy(sql`COALESCE(${events.startDate}, 9999999999) ASC`)
    .limit(limit)
    .offset(offset);

  const eventIds = results.map((r) => r.events.id);
  const allEventVendors: {
    eventId: string;
    vendorId: string;
    businessName: string;
    displayName: string | null;
    slug: string;
    logoUrl: string | null;
    vendorType: string | null;
  }[] = [];

  if (eventIds.length > 0) {
    // Batched to stay under D1's 100-parameter ceiling.
    const BATCH_SIZE = 50;
    for (let i = 0; i < eventIds.length; i += BATCH_SIZE) {
      const batch = eventIds.slice(i, i + BATCH_SIZE);
      const batchResults = await db
        .select({
          eventId: eventVendors.eventId,
          vendorId: vendors.id,
          businessName: vendors.businessName,
          displayName: vendors.displayName,
          slug: vendors.slug,
          logoUrl: vendors.logoUrl,
          vendorType: vendors.vendorType,
        })
        .from(eventVendors)
        .innerJoin(vendors, eq(eventVendors.vendorId, vendors.id))
        .where(and(inArray(eventVendors.eventId, batch), isPubliclyVisibleVendorLink()));
      allEventVendors.push(...batchResults);
    }
  }

  const vendorsByEvent = new Map<string, typeof allEventVendors>();
  for (const ev of allEventVendors) {
    const existing = vendorsByEvent.get(ev.eventId) || [];
    existing.push(ev);
    vendorsByEvent.set(ev.eventId, existing);
  }

  type FullVenue = typeof venues.$inferSelect;
  type FullPromoter = typeof promoters.$inferSelect;
  type EventRow = (typeof results)[number];
  const eventsBase = results.map((r: EventRow) => ({
    ...r.events,
    venue: r.venue as FullVenue | null,
    promoter: r.promoter as FullPromoter | null,
    vendors: (vendorsByEvent.get(r.events.id) || []).map((ev) => ({
      id: ev.vendorId,
      businessName: ev.businessName,
      displayName: ev.displayName,
      slug: ev.slug,
      logoUrl: ev.logoUrl,
      vendorType: ev.vendorType,
    })),
  }));

  const eventsWithDays = await attachEventDayDates(db, eventsBase);

  const countRows = await db
    .select({ n: count() })
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .where(and(...conditions));

  return { events: eventsWithDays, total: countRows[0]?.n ?? 0 };
}

/**
 * Every facet URL that currently qualifies for the index.
 *
 * ── Why the sitemap counts each facet properly instead of estimating ────────
 * A sitemap entry is a request to index. Listing a URL that serves
 * `noindex` asks Google for two contradictory things about the same page, and
 * the report that surfaces it ("Submitted URL marked noindex") is one nobody
 * checks. So this runs the SAME count the page runs, through the same
 * `facetConditions`, and admits only what passes the same floor.
 *
 * That is ~68 COUNT queries across the two launch states. They are small,
 * indexed, and the static sitemap is cached for six hours, so the cost lands a
 * few times a day rather than per request. Chunked concurrency keeps it well
 * inside the edge budget without opening 68 simultaneous D1 calls.
 */
export async function indexableFacetUrls(
  db: FacetDb,
  now: Date
): Promise<Array<{ url: string; kind: string }>> {
  const jobs: Array<{ stateSlug: string; stateCode: string; facet: ResolvedFacet }> = [];
  for (const stateSlug of FACET_STATES) {
    const stateCode = STATE_BY_SLUG[stateSlug];
    if (!stateCode) continue;
    for (const slug of allFacetSlugs(stateSlug)) {
      const facet = resolveFacet(stateSlug, slug, now);
      if (facet) jobs.push({ stateSlug, stateCode, facet });
    }
  }

  const out: Array<{ url: string; kind: string }> = [];
  const CHUNK = 8;
  for (let i = 0; i < jobs.length; i += CHUNK) {
    const chunk = jobs.slice(i, i + CHUNK);
    const counts = await Promise.all(
      chunk.map((j) => countFacetEvents(db, j.stateCode, j.stateSlug, j.facet, now))
    );
    chunk.forEach((j, k) => {
      if (isFacetIndexable(j.facet, counts[k])) {
        out.push({ url: facetUrl(j.stateSlug, j.facet.slug), kind: j.facet.kind });
      }
    });
  }
  return out;
}
