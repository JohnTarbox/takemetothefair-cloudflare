/**
 * OPE-1668 (ask 2) — the category routes (`/events/fairs`, `/events/craft-fairs`,
 * …) and `/events/past`, served from cached sets instead of a listing scan +
 * `count(*)` per URL.
 *
 * Both follow #1820's rule: no predicate is re-implemented in JavaScript. The
 * cached value is built by the SAME query the page ran live (moved here
 * verbatim), so parity holds by construction, and the parity test pins it
 * (listing-family-cache-ope1668.test.ts).
 *
 *  - **Category routes** have a finite key space (six categories, upcoming):
 *    ONE cached card set per category. A page is a slice; the total is its
 *    length. `?includePast=true` stays a live paged read — it is the full
 *    history of the category.
 *  - **`/events/past`** is the full history, so caching its cards unpaged would
 *    be most of the events table. Instead ONE cached ordered-id index per
 *    `(state, category)`: a page reads only its own ≤30 rows by id (an indexed
 *    lookup), and the total is the index length. The scan + `count(*)` pair
 *    runs once per key per TTL instead of once per URL.
 *
 * The one behavioural change in each live query is an `events.id` tiebreak
 * (OPE-1028): without a unique key SQLite may order a tie differently for two
 * OFFSET queries, so a row could land on two pages or none.
 *
 * TTL 300s — the routes' own `revalidate`. Fails open via `kvReadThrough`.
 */
import { and, count, desc, eq, inArray, isNotNull, like, sql } from "drizzle-orm";
import { events, venues, promoters, eventVendors, vendors } from "@/lib/db/schema";
import type { getCloudflareDb } from "@/lib/cloudflare";
import { isPublicEventStatus } from "@/lib/event-status";
import { pastEndPredicate, upcomingEndPredicate } from "@/lib/event-dates";
import { isPubliclyVisibleVendorLink } from "@/lib/vendor-status";
import { attachEventDayDates } from "@/lib/event-days-attach";
import { eventJoinProjection } from "@/lib/db/event-join-projection";
import { containsCI } from "@/lib/db/contains-ci";
import { kvReadThrough, type ReadThroughKv } from "@/lib/kv-read-through";
import { cacheRoundTrip, fromCacheable } from "@/lib/cache-codec";

type ListingDb = ReturnType<typeof getCloudflareDb>;

export const LISTING_FAMILY_CACHE_TTL_SECONDS = 300;

const KEY_PREFIX = "listing:v2";

/** FNV-1a — keeps a key built from arbitrary query-string input short and safe. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Vendor tiles for a page of events (display_name included — EH2.1). */
async function vendorsFor(db: ListingDb, eventIds: string[]) {
  const all: {
    eventId: string;
    vendorId: string;
    businessName: string;
    displayName: string | null;
    slug: string;
    logoUrl: string | null;
    vendorType: string | null;
  }[] = [];
  // Batched to stay under D1's 100-parameter ceiling.
  const BATCH_SIZE = 50;
  for (let i = 0; i < eventIds.length; i += BATCH_SIZE) {
    const batch = eventIds.slice(i, i + BATCH_SIZE);
    const rows = await db
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
    all.push(...rows);
  }
  const byEvent = new Map<string, typeof all>();
  for (const ev of all) {
    const existing = byEvent.get(ev.eventId) || [];
    existing.push(ev);
    byEvent.set(ev.eventId, existing);
  }
  return byEvent;
}

type ProjectionRow = {
  events: { id: string } & Record<string, unknown>;
  venue: unknown;
  promoter: unknown;
};

/** Cast the lite projection back to schema row types; see eventJoinProjection. */
function toCards<R extends ProjectionRow>(
  results: R[],
  vendorsByEvent: Awaited<ReturnType<typeof vendorsFor>>
) {
  type FullVenue = typeof venues.$inferSelect;
  type FullPromoter = typeof promoters.$inferSelect;
  return results.map((r) => ({
    ...(r.events as R["events"]),
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
}

// ── Category routes ─────────────────────────────────────────────────────────

function categoryConditions(category: string, includePast: boolean, now: Date) {
  const conditions = [isPublicEventStatus(), like(events.categories, `%${category}%`)];
  if (!includePast) {
    conditions.push(isNotNull(events.startDate));
    // A2: 24h end-of-day grace per upcomingEndPredicate.
    conditions.push(upcomingEndPredicate(now));
  }
  return conditions;
}

/**
 * The category route's listing query, moved verbatim from
 * category-events-page.tsx (plus the id tiebreak). `limit` omitted = unpaged.
 */
export async function loadCategoryEventCards(
  db: ListingDb,
  category: string,
  opts: { includePast: boolean; limit?: number; offset?: number; now?: Date }
) {
  const now = opts.now ?? new Date();
  const conditions = categoryConditions(category, opts.includePast, now);
  const base = db
    .select(eventJoinProjection)
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .leftJoin(promoters, eq(events.promoterId, promoters.id))
    .where(and(...conditions))
    .orderBy(sql`COALESCE(${events.startDate}, 9999999999) ASC`, events.id);
  const results =
    opts.limit === undefined ? await base : await base.limit(opts.limit).offset(opts.offset ?? 0);
  return toCards(
    results,
    await vendorsFor(
      db,
      results.map((r) => r.events.id)
    )
  );
}

export async function countCategoryEvents(
  db: ListingDb,
  category: string,
  includePast: boolean,
  now: Date = new Date()
) {
  const rows = await db
    .select({ count: count() })
    .from(events)
    .where(and(...categoryConditions(category, includePast, now)));
  return rows[0]?.count || 0;
}

export type CategoryEventCard = Awaited<ReturnType<typeof loadCategoryEventCards>>[number];

export function categorySetCacheKey(category: string): string {
  return `${KEY_PREFIX}:category:${shortHash(category)}`;
}

/** Every upcoming public event in the category, card-shaped, in listing order. */
export async function getCachedCategoryUpcomingSet(
  db: ListingDb,
  kv: ReadThroughKv | null | undefined,
  category: string,
  now: Date = new Date()
): Promise<CategoryEventCard[]> {
  const encoded = await kvReadThrough(
    kv,
    categorySetCacheKey(category),
    LISTING_FAMILY_CACHE_TTL_SECONDS,
    async () =>
      cacheRoundTrip(await loadCategoryEventCards(db, category, { includePast: false, now }))
  );
  return fromCacheable<CategoryEventCard[]>(encoded);
}

// ── /events/past ────────────────────────────────────────────────────────────

export interface PastListingParams {
  state?: string;
  category?: string;
}

function pastConditions(p: PastListingParams, now: Date) {
  const conditions = [isPublicEventStatus(), pastEndPredicate(now)];
  if (p.state) {
    conditions.push(eq(venues.state, p.state) as ReturnType<typeof eq>);
  }
  if (p.category) {
    // OPE-565 — instr() via containsCI, never a LIKE built from the query string.
    conditions.push(containsCI(events.categories, p.category) as ReturnType<typeof eq>);
  }
  return conditions;
}

/** Cards for already-ordered ids (≤ a page), in that order, with vendors + event days. */
async function pastCardsByIds(db: ListingDb, ids: string[]) {
  if (ids.length === 0) return [];
  const results = await db
    .select(eventJoinProjection)
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .leftJoin(promoters, eq(events.promoterId, promoters.id))
    .where(inArray(events.id, ids));
  const byId = new Map(results.map((r) => [r.events.id, r]));
  const ordered = ids.map((id) => byId.get(id)).filter((r) => r !== undefined);
  // Cohort 7 — past listings show the last-occurrence date when event_days exist.
  return attachEventDayDates(db, toCards(ordered, await vendorsFor(db, ids)));
}

/**
 * The /events/past query, moved verbatim from its page.tsx (plus the id
 * tiebreak): one page of cards and the total.
 */
export async function loadPastEventsLive(
  db: ListingDb,
  p: PastListingParams,
  opts: { limit: number; offset: number; now?: Date }
) {
  const now = opts.now ?? new Date();
  const conditions = pastConditions(p, now);
  // Narrow projection — D1's 100-col result-row cap; see eventJoinProjection.
  const [results, totalResult] = await Promise.all([
    db
      .select(eventJoinProjection)
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(and(...conditions))
      .orderBy(desc(events.endDate), events.id)
      .limit(opts.limit)
      .offset(opts.offset),
    db
      .select({ count: count() })
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(and(...conditions)),
  ]);
  const cards = toCards(
    results,
    await vendorsFor(
      db,
      results.map((r) => r.events.id)
    )
  );
  return {
    events: await attachEventDayDates(db, cards),
    total: totalResult[0]?.count ?? 0,
  };
}

export function pastIndexCacheKey(p: PastListingParams): string {
  return `${KEY_PREFIX}:past:${shortHash(JSON.stringify([p.state ?? "", p.category ?? ""]))}`;
}

/** Every matching past id, in listing order — the live query's ORDER BY, unpaged. */
export async function getCachedPastIndex(
  db: ListingDb,
  kv: ReadThroughKv | null | undefined,
  p: PastListingParams,
  now: Date = new Date()
): Promise<string[]> {
  return kvReadThrough(kv, pastIndexCacheKey(p), LISTING_FAMILY_CACHE_TTL_SECONDS, async () => {
    const rows = await db
      .select({ id: events.id })
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(and(...pastConditions(p, now)))
      .orderBy(desc(events.endDate), events.id);
    return rows.map((r) => r.id);
  });
}

/** The cached-path answer: the same `{ events, total }` as `loadPastEventsLive`. */
export async function loadPastEventsCached(
  db: ListingDb,
  kv: ReadThroughKv | null | undefined,
  p: PastListingParams,
  opts: { limit: number; offset: number; now?: Date }
) {
  const ids = await getCachedPastIndex(db, kv, p, opts.now);
  const offset = Number.isFinite(opts.offset) && opts.offset > 0 ? opts.offset : 0;
  return {
    events: await pastCardsByIds(db, ids.slice(offset, offset + opts.limit)),
    total: ids.length,
  };
}
