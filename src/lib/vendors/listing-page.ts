/**
 * OPE-1395 (IDX1) — the /vendors listing's data load, one page at a time.
 *
 * Before: the page `SELECT *`-ed every live vendor (11.5k rows joined to
 * users), then fetched upcoming events for EVERY one of them in ~230
 * sequential 50-id batches, then sliced 50 cards out in memory. Each render
 * read ~34k rows plus the event fan-out, and the page sat at 0.66 s cold TTFB.
 *
 * Now, in four steps:
 *   1. The match set is read as a NARROW projection — the grouping fields only
 *      (plus the `?q=` text fields when a search is active) — ordered by
 *      business_name. `idx_vendors_deleted_business_name` (drizzle/0374) serves
 *      both the `deleted_at IS NULL` filter and the order, so no temp B-tree.
 *   2. The EH2.2 brand-collapse grouper runs on that projection exactly as
 *      before, producing the card list. `?hasEvents=true` is applied with ONE
 *      `SELECT DISTINCT vendor_id` over upcoming public links (no bind list),
 *      not by loading every vendor's events.
 *   3. The card list (ids only) is paginated.
 *   4. Full card rows and their upcoming events are fetched for the 50 cards
 *      on THIS page only.
 *
 * Why not LIMIT/OFFSET on the vendors query itself: a page is a page of
 * CARDS, not rows. Brand-parent collapse folds N offices into one card at the
 * first office's position and suppresses self-mode brand hubs, and `?q=`
 * matches with JS `toLowerCase()` (Unicode-aware; SQLite's lower() is ASCII
 * only). Reproducing either in SQL would change which vendors appear on which
 * page. The narrow projection keeps the result set byte-identical while
 * removing the full-row payload and the event fan-out — the expensive parts.
 *
 * The rendered result is identical to the pre-OPE-1395 page, including one
 * quirk kept on purpose: `ownerEmailVerified` is only ever true for a card
 * whose row was in the match set (the old code read it off the match-set join
 * and defaulted brand rows fetched separately to false). See the test file.
 */
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { chunkIds } from "@takemetothefair/utils";
import { searchSlugForm } from "@takemetothefair/utils";
import { vendors, users, eventVendors, events, venues, userFavorites } from "@/lib/db/schema";
import type { Database } from "@/lib/db";
import {
  collectBrandParentIdsToLoad,
  groupVendorsForListing,
  type GroupableVendor,
} from "@/lib/vendor-listing-grouping";
import { isPubliclyVisibleVendorLink } from "@/lib/vendor-status";
import { isPublicEventStatus } from "@/lib/event-status";
import { upcomingEndPredicate } from "@/lib/event-dates";

export interface VendorListingParams {
  type?: string;
  q?: string;
  hasEvents?: string;
  /** Set only when `?favorites=true` AND a user is signed in. */
  favoriteUserId?: string;
}

/**
 * Event-batch size for the per-page event read. The WHERE clause binds 12
 * params besides the IN list (2 vendor-link statuses, public_visible, 2 event
 * statuses, 6 lifecycle statuses, the cutoff): 80 + 12 = 92, under D1's 100.
 * A 50-card page can reference a few more ids than cards (a collapsed brand
 * carries its offices), so 80 keeps a normal page to ONE event read. If any of
 * those status lists grows, re-check this — the test asserts statement shape.
 */
const EVENT_BATCH_SIZE = 80;

/** The grouping fields + the `?q=` match fields. */
function narrowProjection(withDescription: boolean) {
  return {
    id: vendors.id,
    role: vendors.role,
    brandParentVendorId: vendors.brandParentVendorId,
    operatorParentVendorId: vendors.operatorParentVendorId,
    aliasOfVendorId: vendors.aliasOfVendorId,
    displayOverridePermitted: vendors.displayOverridePermitted,
    displayMode: vendors.displayMode,
    defaultChildDisplay: vendors.defaultChildDisplay,
    businessName: vendors.businessName,
    displayName: vendors.displayName,
    vendorType: vendors.vendorType,
    slug: vendors.slug,
    // Descriptions are the bulk of a vendor row; only a search reads them.
    description: withDescription ? vendors.description : sql<string | null>`NULL`,
  };
}

type NarrowRow = {
  id: string;
  role: GroupableVendor["role"];
  brandParentVendorId: string | null;
  operatorParentVendorId: string | null;
  aliasOfVendorId: string | null;
  displayOverridePermitted: boolean;
  displayMode: GroupableVendor["displayMode"];
  defaultChildDisplay: GroupableVendor["defaultChildDisplay"];
  businessName: string;
  displayName: string | null;
  vendorType: string | null;
  slug: string;
  description: string | null;
};

function toGroupable(v: NarrowRow): GroupableVendor {
  return {
    id: v.id,
    role: v.role,
    brandParentVendorId: v.brandParentVendorId,
    operatorParentVendorId: v.operatorParentVendorId,
    aliasOfVendorId: v.aliasOfVendorId,
    displayOverridePermitted: v.displayOverridePermitted,
    displayMode: v.displayMode,
    defaultChildDisplay: v.defaultChildDisplay,
  };
}

/** Events shown on a card — upcoming, public link, public event. */
function upcomingPublicLinkWhere(now: Date): SQL | undefined {
  return and(
    isPubliclyVisibleVendorLink(),
    isPublicEventStatus(),
    // A2 (Dev backlog 2026-06-05): 24h end-of-day grace.
    upcomingEndPredicate(now)
  );
}

export async function loadVendorListingPage(
  db: Database,
  params: VendorListingParams,
  page: { number: number; size: number },
  now: Date = new Date()
) {
  // Soft-deleted vendors (drizzle/0053) are always excluded from the listing.
  const conditions: SQL[] = [isNull(vendors.deletedAt)];
  if (params.type) conditions.push(eq(vendors.vendorType, params.type));
  if (params.favoriteUserId) {
    // Subquery, not an id list — avoids D1's bind-parameter cap.
    conditions.push(
      sql`${vendors.id} IN (SELECT ${userFavorites.favoritableId} FROM ${userFavorites} WHERE ${userFavorites.userId} = ${params.favoriteUserId} AND ${userFavorites.favoritableType} = 'VENDOR')`
    );
  }

  // ── 1. Match set, narrow ─────────────────────────────────────────────
  let matched: NarrowRow[] = await db
    .select(narrowProjection(Boolean(params.q)))
    .from(vendors)
    .where(and(...conditions))
    .orderBy(vendors.businessName);

  if (params.q) {
    const lowerQuery = params.q.toLowerCase();
    // OPE-647 — `toLowerCase()` does not fold diacritics, so `aehko` never
    // matched `aéhkō`. The slug column already holds the transliterated form.
    const slugQuery = searchSlugForm(params.q);
    // EH2.1 — match business_name OR the brand display_name override.
    matched = matched.filter(
      (v) =>
        v.businessName.toLowerCase().includes(lowerQuery) ||
        v.displayName?.toLowerCase().includes(lowerQuery) ||
        v.description?.toLowerCase().includes(lowerQuery) ||
        v.vendorType?.toLowerCase().includes(lowerQuery) ||
        (slugQuery ? v.slug.includes(slugQuery) : false)
    );
  }

  if (matched.length === 0) return { vendors: [], totalCount: 0 };

  // ── 2. EH2.2 brand-parent grouping (spec §C2) ────────────────────────
  // The pure rule lives in src/lib/vendor-listing-grouping.ts. This block
  // only loads what it needs: brand parents referenced by matched offices
  // but not matched themselves, and every office of a brand that collapses.
  const matchedIds = new Set(matched.map((v) => v.id));
  const groupableMatches = matched.map(toGroupable);
  const rowById = new Map<string, NarrowRow>();
  for (const v of matched) rowById.set(v.id, v);

  const brandParentIdsNeeded = collectBrandParentIdsToLoad(groupableMatches);
  const missingBrandParentIds = brandParentIdsNeeded.filter((id) => !matchedIds.has(id));
  for (const batch of chunkIds(missingBrandParentIds)) {
    const rows: NarrowRow[] = await db
      .select(narrowProjection(false))
      .from(vendors)
      .where(and(inArray(vendors.id, batch), isNull(vendors.deletedAt)));
    for (const r of rows) rowById.set(r.id, r);
  }

  const brandParentsForGrouping = new Map<string, GroupableVendor>();
  for (const id of brandParentIdsNeeded) {
    const row = rowById.get(id);
    if (row) brandParentsForGrouping.set(id, toGroupable(row));
  }
  // A brand_parent-mode NATIONAL row matched directly (search hit the brand).
  for (const v of matched) {
    if (v.role === "NATIONAL") brandParentsForGrouping.set(v.id, toGroupable(v));
  }

  const brandIdsToCollapse: string[] = [];
  for (const [id, brand] of brandParentsForGrouping) {
    if (brand.defaultChildDisplay === "brand_parent") brandIdsToCollapse.push(id);
  }
  const officesByBrandId = new Map<string, GroupableVendor[]>();
  for (const batch of chunkIds(brandIdsToCollapse)) {
    const offices: NarrowRow[] = await db
      .select(narrowProjection(false))
      .from(vendors)
      .where(and(inArray(vendors.brandParentVendorId, batch), isNull(vendors.deletedAt)));
    for (const o of offices) {
      rowById.set(o.id, o);
      if (!o.brandParentVendorId) continue;
      const arr = officesByBrandId.get(o.brandParentVendorId) ?? [];
      arr.push(toGroupable(o));
      officesByBrandId.set(o.brandParentVendorId, arr);
    }
  }

  let cards = groupVendorsForListing({
    matchedVendors: groupableMatches,
    brandParentsById: brandParentsForGrouping,
    officesByBrandId,
  }).filter((card) => rowById.has(card.vendorId));

  // ── 2b. ?hasEvents=true — one DISTINCT read, no id list ──────────────
  if (params.hasEvents === "true") {
    const withEvents = await db
      .selectDistinct({ vendorId: eventVendors.vendorId })
      .from(eventVendors)
      .innerJoin(events, eq(eventVendors.eventId, events.id))
      .where(upcomingPublicLinkWhere(now));
    const ids = new Set(withEvents.map((r) => r.vendorId));
    cards = cards.filter((card) => card.aggregatedEventVendorIds.some((id) => ids.has(id)));
  }

  // ── 3. Paginate the card list ────────────────────────────────────────
  const totalCount = cards.length;
  const start = (page.number - 1) * page.size;
  const pageCards = cards.slice(start, start + page.size);
  if (pageCards.length === 0) return { vendors: [], totalCount };

  // ── 4. Full rows + events for THIS page only ─────────────────────────
  const fetchFullRows = (ids: string[]) =>
    db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        displayName: vendors.displayName,
        role: vendors.role,
        brandParentVendorId: vendors.brandParentVendorId,
        operatorParentVendorId: vendors.operatorParentVendorId,
        aliasOfVendorId: vendors.aliasOfVendorId,
        displayOverridePermitted: vendors.displayOverridePermitted,
        displayMode: vendors.displayMode,
        slug: vendors.slug,
        description: vendors.description,
        vendorType: vendors.vendorType,
        products: vendors.products,
        logoUrl: vendors.logoUrl,
        imageFocalX: vendors.imageFocalX,
        imageFocalY: vendors.imageFocalY,
        website: vendors.website,
        verified: vendors.verified,
        commercial: vendors.commercial,
        claimed: vendors.claimed,
        enhancedProfile: vendors.enhancedProfile,
        verifiedPro: vendors.verifiedPro,
        city: vendors.city,
        state: vendors.state,
        ownerEmailVerified: users.emailVerified,
      })
      .from(vendors)
      .leftJoin(users, eq(vendors.userId, users.id))
      .where(inArray(vendors.id, ids));
  const fullById = new Map<string, Awaited<ReturnType<typeof fetchFullRows>>[number]>();
  for (const batch of chunkIds(pageCards.map((c) => c.vendorId))) {
    for (const r of await fetchFullRows(batch)) fullById.set(r.id, r);
  }
  const eventVendorIds = [...new Set(pageCards.flatMap((c) => c.aggregatedEventVendorIds))];
  type CardEvent = {
    vendorId: string;
    eventId: string;
    eventName: string;
    eventSlug: string;
    startDate: Date | null;
    endDate: Date | null;
    imageUrl: string | null;
    venueName: string | null;
    venueCity: string | null;
    venueState: string | null;
  };
  const eventsByVendor = new Map<string, CardEvent[]>();
  for (const batch of chunkIds(eventVendorIds, EVENT_BATCH_SIZE)) {
    const rows: CardEvent[] = await db
      .select({
        vendorId: eventVendors.vendorId,
        eventId: events.id,
        eventName: events.name,
        eventSlug: events.slug,
        startDate: events.startDate,
        endDate: events.endDate,
        imageUrl: events.imageUrl,
        venueName: venues.name,
        venueCity: venues.city,
        venueState: venues.state,
      })
      .from(eventVendors)
      .innerJoin(events, eq(eventVendors.eventId, events.id))
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(and(inArray(eventVendors.vendorId, batch), upcomingPublicLinkWhere(now)))
      .orderBy(asc(events.startDate));
    for (const ev of rows) {
      const arr = eventsByVendor.get(ev.vendorId) ?? [];
      arr.push(ev);
      eventsByVendor.set(ev.vendorId, arr);
    }
  }

  const result = pageCards
    .map((card) => {
      const v = fullById.get(card.vendorId);
      if (!v) return null;

      // Aggregate events over the card's vendor-id set, deduped by event id.
      const eventById = new Map<string, CardEvent>();
      for (const vid of card.aggregatedEventVendorIds) {
        for (const ev of eventsByVendor.get(vid) ?? []) {
          if (!eventById.has(ev.eventId)) eventById.set(ev.eventId, ev);
        }
      }
      const aggregatedEvents = [...eventById.values()].sort((a, b) => {
        const at = a.startDate?.getTime() ?? Infinity;
        const bt = b.startDate?.getTime() ?? Infinity;
        return at - bt;
      });

      return {
        id: v.id,
        // OPE-238 — `false` when the vendor has no owner row at all. Read
        // only for match-set rows, as before OPE-1395 (see file header).
        ownerEmailVerified: matchedIds.has(v.id) ? Boolean(v.ownerEmailVerified) : false,
        businessName: v.businessName,
        displayName: v.displayName,
        role: v.role,
        brandParentVendorId: v.brandParentVendorId,
        operatorParentVendorId: v.operatorParentVendorId,
        aliasOfVendorId: v.aliasOfVendorId,
        displayOverridePermitted: v.displayOverridePermitted,
        displayMode: v.displayMode,
        slug: v.slug,
        description: v.description,
        vendorType: v.vendorType,
        products: v.products,
        logoUrl: v.logoUrl,
        imageFocalX: v.imageFocalX,
        imageFocalY: v.imageFocalY,
        website: v.website,
        verified: v.verified,
        commercial: v.commercial,
        claimed: v.claimed,
        enhancedProfile: v.enhancedProfile,
        verifiedPro: v.verifiedPro,
        city: v.city,
        state: v.state,
        isBrandCollapsed: card.isBrandCollapsed,
        officeCount: card.isBrandCollapsed ? (officesByBrandId.get(v.id)?.length ?? 0) : undefined,
        events: aggregatedEvents.map((e) => ({
          id: e.eventId,
          name: e.eventName,
          slug: e.eventSlug,
          startDate: e.startDate,
          endDate: e.endDate,
          imageUrl: e.imageUrl,
          venue: e.venueName ? { name: e.venueName, city: e.venueCity, state: e.venueState } : null,
        })),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return { vendors: result, totalCount };
}

export type VendorListingItem = Awaited<
  ReturnType<typeof loadVendorListingPage>
>["vendors"][number];
