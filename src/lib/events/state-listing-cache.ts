/**
 * OPE-1662 — the state landing pages and the state facet pages are served from
 * cached sets instead of a fresh D1 scan per URL.
 *
 * ── What was happening ─────────────────────────────────────────────────────
 *
 * Every `/events/<state>` and `/events/<state>/<facet>` render ran, from
 * scratch, a filtered listing SELECT, a `count(*)` of the same predicate, a
 * vendor batch, an `event_days` batch, and (on the state page) a whole-state
 * inventory scan plus a year-span query — 6–8 statements, each carrying the
 * unindexable `CASE … EXISTS … upper()` state predicate. A crawl of distinct
 * facet and `?page=` URLs paid all of it per URL: on 11-13 09:02–09:06Z the top
 * three D1 queries by rows read were exactly these listing shapes, and on 11-17
 * 00:27Z D1 hit its CPU limit and reset with these pages in flight.
 *
 * ── What it does now ───────────────────────────────────────────────────────
 *
 *  1. ONE cached copy per state of every upcoming public event in that state,
 *     card-shaped (projection + vendors + event-day dates), in listing order.
 *     It is built by the SAME query code the page ran before
 *     (`loadStateEventCards`), unpaged. A state page is a slice of it and its
 *     total is its length. ≤160 events / ≤200 vendor links per state (prod,
 *     2026-11-17), so the copy is small.
 *  2. ONE cached index per facet: the ordered matching ids
 *     (`getFacetEventIds` — the same SQL predicates and ORDER BY as the live
 *     facet listing) and its indexability depth (seasonality is cached separately,
 *     built only for an empty page — see getCachedFacetSeasonality). A facet page
 *     maps its id slice onto the state copy. Facet ⊂ state by construction
 *     (same base conditions), so every id is found — and if one is not (the two
 *     entries were built minutes apart and an event changed in between), the
 *     caller falls back to the live query for that page.
 *
 * So `?page=` of any value costs no D1 at all, and a facet costs its queries
 * once per TTL, not once per URL. No facet predicate is re-implemented in
 * JavaScript: parity holds because the cached path runs the same SQL, which is
 * what the parity test pins (state-listing-cache-ope1662.test.ts).
 *
 * `?includePast=true` (the whole history) stays a live paged read: it is not
 * the crawled shape, and caching it unpaged would be the full events table.
 *
 * TTL 300s — the same staleness the routes already declare (`revalidate = 300`).
 * Fails open to D1 via `kvReadThrough`.
 */
import { and, count, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  events,
  venues,
  promoters,
  eventVendors,
  vendors,
  eventInStateWhere,
} from "@/lib/db/schema";
import type { getCloudflareDb } from "@/lib/cloudflare";
import { isPublicEventStatus } from "@/lib/event-status";
import { upcomingEndPredicate } from "@/lib/event-dates";
import { isPubliclyVisibleVendorLink } from "@/lib/vendor-status";
import { attachEventDayDates } from "@/lib/event-days-attach";
import { eventJoinProjection } from "@/lib/db/event-join-projection";
import { kvReadThrough, type ReadThroughKv } from "@/lib/kv-read-through";
import { cacheRoundTrip, fromCacheable } from "@/lib/cache-codec";
import { countFacetDepth, getFacetEventIds, getFacetSeasonality } from "@/lib/events/facet-query";
import { facetDepthBasis, type ResolvedFacet } from "@/lib/events/facets";

type ListingDb = ReturnType<typeof getCloudflareDb>;

export const STATE_LISTING_CACHE_TTL_SECONDS = 300;

/** Bump the version when the cached shape changes, so old entries are never decoded as new. */
const KEY_PREFIX = "listing:v2";

export function stateSetCacheKey(stateCode: string): string {
  return `${KEY_PREFIX}:state:${stateCode.toUpperCase()}`;
}

/**
 * Keyed on the facet's resolved window too: a month or weekend facet's window
 * depends on `now`, so the key moves when the window does instead of serving
 * last weekend's ids for up to a TTL.
 */
export function facetIndexCacheKey(stateSlug: string, facet: ResolvedFacet): string {
  const w = facet.window ? `${facet.window.start.getTime()}-${facet.window.end.getTime()}` : "-";
  return `${KEY_PREFIX}:facet:${stateSlug}:${facet.kind}:${facet.slug}:${w}`;
}

/**
 * The state page's listing query, moved here verbatim from
 * state-events-page.tsx so the cached set and the live `includePast` path share
 * one copy. `limit` omitted = every matching row.
 */
export async function loadStateEventCards(
  db: ListingDb,
  stateCode: string,
  opts: { includePast: boolean; limit?: number; offset?: number }
) {
  const conditions = stateListingConditions(stateCode, opts.includePast);

  // Narrow projection — D1 100-col cap; see eventJoinProjection.
  const base = db
    .select(eventJoinProjection)
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .leftJoin(promoters, eq(events.promoterId, promoters.id))
    .where(and(...conditions))
    // OPE-1028 — `id` breaks start_date ties. Most events sit at noon UTC, so a
    // whole day ties; without a unique key SQLite may order that tie differently
    // for the page-1 and page-2 OFFSET queries, and a row can land on both or neither.
    .orderBy(sql`COALESCE(${events.startDate}, 9999999999) ASC`, events.id);
  const results =
    opts.limit === undefined ? await base : await base.limit(opts.limit).offset(opts.offset ?? 0);

  // Batch-fetch vendors
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
          // EH2.1 — brand display_name override surfaces on per-state event
          // card vendor tiles.
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

  // Cast lite projection back to schema row types — see
  // eventJoinProjection for the audit + maintenance contract.
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
  // Cohort 7 follow-up (2026-06-01) — same event_days attachment as the other
  // event-listing pages so the grid shows the next occurrence date in badges.
  return attachEventDayDates(db, eventsBase);
}

export type StateEventCard = Awaited<ReturnType<typeof loadStateEventCards>>[number];

export function stateListingConditions(stateCode: string, includePast: boolean) {
  const conditions = [isPublicEventStatus(), eventInStateWhere(stateCode)];
  if (!includePast) {
    conditions.push(isNotNull(events.startDate));
    // A2 (Dev backlog 2026-06-05): 24h end-of-day grace per upcomingEndPredicate.
    conditions.push(upcomingEndPredicate(new Date()));
  }
  return conditions;
}

export async function countStateEvents(db: ListingDb, stateCode: string, includePast: boolean) {
  const rows = await db
    .select({ count: count() })
    .from(events)
    .where(and(...stateListingConditions(stateCode, includePast)));
  return rows[0]?.count || 0;
}

/** Every upcoming public event in the state, card-shaped, in listing order. */
export async function getCachedStateUpcomingSet(
  db: ListingDb,
  kv: ReadThroughKv | null | undefined,
  stateCode: string
): Promise<StateEventCard[]> {
  const encoded = await kvReadThrough(
    kv,
    stateSetCacheKey(stateCode),
    STATE_LISTING_CACHE_TTL_SECONDS,
    async () => cacheRoundTrip(await loadStateEventCards(db, stateCode, { includePast: false }))
  );
  return fromCacheable<StateEventCard[]>(encoded);
}

export interface FacetIndex {
  /** Matching ids in listing order (= the live facet listing, unpaged). */
  ids: string[];
  /** `countFacetForIndexing`'s answer. */
  depth: number;
}

export async function getCachedFacetIndex(
  db: ListingDb,
  kv: ReadThroughKv | null | undefined,
  stateCode: string,
  stateSlug: string,
  facet: ResolvedFacet,
  now: Date
): Promise<FacetIndex> {
  const encoded = await kvReadThrough(
    kv,
    facetIndexCacheKey(stateSlug, facet),
    STATE_LISTING_CACHE_TTL_SECONDS,
    async (): Promise<unknown> => {
      const ids = await getFacetEventIds(db, stateCode, stateSlug, facet, now);
      // countFacetForIndexing, unrolled: the forward basis IS the listing
      // count, which `ids` already is — one query saved per build.
      const depth =
        facetDepthBasis(facet.kind) === "rolling12"
          ? await countFacetDepth(db, stateCode, stateSlug, facet, now)
          : ids.length;
      return cacheRoundTrip({ ids, depth } satisfies FacetIndex);
    }
  );
  return fromCacheable<FacetIndex>(encoded);
}

/**
 * `getFacetSeasonality`, cached under its own key and built ONLY when a page
 * renders an empty list (the OPE-470 contract).
 *
 * The first cut built it into every facet index, so an out-of-range `?page=`
 * would not reach D1. Measured on prod (OPE-1662, 11-17 15:22Z cold crawl):
 * those rolling-window statements were ~860K of the 1.58M rows a cold crawl
 * read — about 4.5K rows per call, on every facet, for a line almost no page
 * shows. Cached separately, an out-of-range page still costs D1 at most once
 * per facet per TTL, and a populated page never pays for it.
 */
export async function getCachedFacetSeasonality(
  db: ListingDb,
  kv: ReadThroughKv | null | undefined,
  stateCode: string,
  stateSlug: string,
  facet: ResolvedFacet,
  now: Date
): Promise<{ total: number; months: number[] }> {
  return kvReadThrough(
    kv,
    `${facetIndexCacheKey(stateSlug, facet)}:season`,
    STATE_LISTING_CACHE_TTL_SECONDS,
    () => getFacetSeasonality(db, stateCode, stateSlug, facet, now)
  );
}

/**
 * LIMIT/OFFSET in memory, with SQLite's handling of a non-positive offset (it
 * is treated as 0 — `?page=0` has always served page 1's rows).
 */
export function pageSlice<T>(rows: readonly T[], page: number, limit: number): T[] {
  const raw = (page - 1) * limit;
  const offset = Number.isFinite(raw) && raw > 0 ? raw : 0;
  return rows.slice(offset, offset + limit);
}

/**
 * A facet page's rows, mapped from the state set. `null` when any id is
 * missing from the set — the two entries disagree, so the caller must not
 * render a short page as if it were the answer; it reads live instead.
 */
export function facetPageFromSet<T extends { id: string }>(
  index: FacetIndex,
  set: readonly T[],
  page: number,
  limit: number
): T[] | null {
  const ids = pageSlice(index.ids, page, limit);
  if (ids.length === 0) return [];
  const byId = new Map(set.map((e) => [e.id, e]));
  const out: T[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) return null;
    out.push(row);
  }
  return out;
}
