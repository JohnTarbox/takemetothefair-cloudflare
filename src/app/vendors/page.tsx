import type { Metadata } from "next";
import Link from "next/link";
import { Search, X, Heart, Calendar } from "lucide-react";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, users, eventVendors, events, venues, userFavorites } from "@/lib/db/schema";
import { eq, and, asc, isNotNull, isNull, inArray, sql } from "drizzle-orm";
import {
  collectBrandParentIdsToLoad,
  groupVendorsForListing,
  type GroupableVendor,
} from "@/lib/vendor-listing-grouping";
import { isPublicVendorStatus } from "@/lib/vendor-status";
import { isPublicEventStatus } from "@/lib/event-status";
import { upcomingEndPredicate } from "@/lib/event-dates";
import { auth } from "@/lib/auth";
import { VendorsView } from "@/components/vendors/vendors-view";
import { logError } from "@/lib/logger";
import { ItemListSchema } from "@/components/seo/ItemListSchema";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { Pagination } from "@/components/ui/pagination";
import { MobileFilterDrawer } from "@/components/ui/mobile-filter-drawer";
import {
  FeaturedVendorsSection,
  type FeaturedVendor,
} from "@/components/vendors/FeaturedVendorsSection";

const PAGE_SIZE = 50;

export const revalidate = 3600; // Cache for 1 hour

export const metadata: Metadata = {
  title: "Fair & Festival Vendors | Meet Me at the Fair",
  description:
    "Meet the artisans, food vendors, and businesses participating in fairs and festivals.",
  alternates: { canonical: "https://meetmeatthefair.com/vendors" },
  openGraph: {
    title: "Fair & Festival Vendors | Meet Me at the Fair",
    description:
      "Meet the artisans, food vendors, and businesses participating in fairs and festivals.",
    url: "https://meetmeatthefair.com/vendors",
    siteName: "Meet Me at the Fair",
    type: "website",
    images: [
      {
        url: "https://meetmeatthefair.com/og-default.png",
        width: 1200,
        height: 630,
        alt: "Meet Me at the Fair — Discover Local Fairs, Festivals & Events",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Fair & Festival Vendors | Meet Me at the Fair",
    description:
      "Meet the artisans, food vendors, and businesses participating in fairs and festivals.",
    images: ["https://meetmeatthefair.com/og-default.png"],
  },
};

// Helper to build query strings while preserving existing params
function buildQueryString(params: Record<string, string | undefined>): string {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) searchParams.set(key, value);
  });
  const str = searchParams.toString();
  return str ? `?${str}` : "";
}

interface SearchParams {
  type?: string;
  favorites?: string;
  hasEvents?: string;
  q?: string;
  page?: string;
}

async function getVendors(searchParams: SearchParams, favoriteUserId?: string) {
  const db = getCloudflareDb();

  try {
    // Build conditions. Soft-deleted vendors (drizzle/0053) are always
    // excluded from the public listing.
    const conditions: (ReturnType<typeof eq> | ReturnType<typeof isNull>)[] = [
      isNull(vendors.deletedAt),
    ];
    if (searchParams.type) {
      conditions.push(eq(vendors.vendorType, searchParams.type));
    }
    // Use subquery for favorites filter (avoids D1 bind parameter limit)
    if (searchParams.favorites === "true" && favoriteUserId) {
      conditions.push(
        sql`${vendors.id} IN (SELECT ${userFavorites.favoritableId} FROM ${userFavorites} WHERE ${userFavorites.userId} = ${favoriteUserId} AND ${userFavorites.favoritableType} = 'VENDOR')`
      );
    } else if (searchParams.favorites === "true" && !favoriteUserId) {
      return [];
    }

    // Query 1: Get all vendors (filtered by deleted_at + optional type/favorites)
    const vendorQuery = db
      .select()
      .from(vendors)
      .leftJoin(users, eq(vendors.userId, users.id))
      .where(and(...conditions))
      .orderBy(vendors.businessName);

    let vendorResults = await vendorQuery;

    // Filter by search query if provided
    if (searchParams.q) {
      const lowerQuery = searchParams.q.toLowerCase();
      // EH2.1 — match against either business_name or the brand display_name
      // override so brand searches surface rows whose only-the-override
      // stores the brand surface (e.g. "LeafFilter" matches the row whose
      // business_name is "LeafFilter North LLC"). Brand-parent search
      // dedup (collapsing 6 offices into one hub row) is PR EH2.4.
      vendorResults = vendorResults.filter(
        (v) =>
          v.vendors.businessName.toLowerCase().includes(lowerQuery) ||
          v.vendors.displayName?.toLowerCase().includes(lowerQuery) ||
          v.vendors.description?.toLowerCase().includes(lowerQuery) ||
          v.vendors.vendorType?.toLowerCase().includes(lowerQuery)
      );
    }

    if (vendorResults.length === 0) {
      return [];
    }

    // ── EH2.2 brand-parent collapse pre-processing ────────────────────
    // Spec §C2 — the listing renders one card per "display group", keyed
    // by COALESCE(brand_parent_vendor_id, id). For brand_parent-mode
    // brands the offices collapse into a single hub card; for self-mode
    // brands the brand hub is suppressed from the listing entirely.
    //
    // The pure-function grouping rule lives in
    // src/lib/vendor-listing-grouping.ts and is unit-tested there. This
    // block is responsible only for the I/O: load the brand parent rows
    // referenced by matched offices, load every office of any brand we
    // intend to collapse (so its events aggregate into the brand card
    // even when only some offices made the match set), then call the
    // pure grouper.
    const groupableMatches: (GroupableVendor & { rowIndex: number })[] = vendorResults.map(
      (v, idx) => ({
        rowIndex: idx,
        id: v.vendors.id,
        role: v.vendors.role,
        brandParentVendorId: v.vendors.brandParentVendorId,
        operatorParentVendorId: v.vendors.operatorParentVendorId,
        aliasOfVendorId: v.vendors.aliasOfVendorId,
        displayOverridePermitted: v.vendors.displayOverridePermitted,
        displayMode: v.vendors.displayMode,
        defaultChildDisplay: v.vendors.defaultChildDisplay,
      })
    );

    // Brand parent rows referenced by matched offices but NOT in the
    // match set themselves (caller searched for office only). One small
    // batch SELECT to pull them in. Brand parents that ARE in the match
    // set are already loaded — reuse those rows directly.
    const matchedIds = new Set(vendorResults.map((v) => v.vendors.id));
    const brandParentIdsNeeded = collectBrandParentIdsToLoad(groupableMatches);
    const missingBrandParentIds = brandParentIdsNeeded.filter((id) => !matchedIds.has(id));
    type VendorRow = (typeof vendorResults)[number]["vendors"];
    const extraBrandParentRows: VendorRow[] =
      missingBrandParentIds.length > 0
        ? await db
            .select()
            .from(vendors)
            .where(and(inArray(vendors.id, missingBrandParentIds), isNull(vendors.deletedAt)))
        : [];
    // Build a unified lookup: matched rows + extra brand parents, both
    // keyed by id. Consumers (grouper + card renderer) only need to read
    // the union.
    const vendorRowById = new Map<string, VendorRow>();
    for (const v of vendorResults) vendorRowById.set(v.vendors.id, v.vendors);
    for (const v of extraBrandParentRows) vendorRowById.set(v.id, v);
    const brandParentsForGrouping = new Map<string, GroupableVendor>();
    for (const id of brandParentIdsNeeded) {
      const row = vendorRowById.get(id);
      if (!row) continue;
      brandParentsForGrouping.set(id, {
        id: row.id,
        role: row.role,
        brandParentVendorId: row.brandParentVendorId,
        operatorParentVendorId: row.operatorParentVendorId,
        aliasOfVendorId: row.aliasOfVendorId,
        displayOverridePermitted: row.displayOverridePermitted,
        displayMode: row.displayMode,
        defaultChildDisplay: row.defaultChildDisplay,
      });
    }
    // Also register any NATIONAL row that's a brand_parent-mode brand
    // and is in the match set directly (search hit the brand). The
    // grouper consults brandParentsForGrouping for the BRAND-row case
    // when computing collapsedBrandIds for direct NATIONAL matches.
    for (const v of vendorResults) {
      if (v.vendors.role === "NATIONAL") {
        brandParentsForGrouping.set(v.vendors.id, {
          id: v.vendors.id,
          role: v.vendors.role,
          brandParentVendorId: v.vendors.brandParentVendorId,
          operatorParentVendorId: v.vendors.operatorParentVendorId,
          aliasOfVendorId: v.vendors.aliasOfVendorId,
          displayOverridePermitted: v.vendors.displayOverridePermitted,
          displayMode: v.vendors.displayMode,
          defaultChildDisplay: v.vendors.defaultChildDisplay,
        });
      }
    }

    // For any brand_parent-mode brand we'll render as a collapsed card,
    // fetch ALL its LOCAL_OFFICE children (whether or not they made the
    // match set) so we can aggregate their events into the brand card.
    const brandIdsToCollapse: string[] = [];
    for (const [id, brand] of brandParentsForGrouping) {
      if (brand.defaultChildDisplay === "brand_parent") brandIdsToCollapse.push(id);
    }
    type OfficeRow = VendorRow;
    const allOfficesForCollapsed: OfficeRow[] =
      brandIdsToCollapse.length > 0
        ? await db
            .select()
            .from(vendors)
            .where(
              and(
                inArray(vendors.brandParentVendorId, brandIdsToCollapse),
                isNull(vendors.deletedAt)
              )
            )
        : [];
    // Register these office rows in vendorRowById so the renderer can
    // pull their event ids without an additional SELECT.
    for (const o of allOfficesForCollapsed) vendorRowById.set(o.id, o);
    const officesByBrandId = new Map<string, GroupableVendor[]>();
    for (const o of allOfficesForCollapsed) {
      if (!o.brandParentVendorId) continue;
      const arr = officesByBrandId.get(o.brandParentVendorId) ?? [];
      arr.push({
        id: o.id,
        role: o.role,
        brandParentVendorId: o.brandParentVendorId,
        operatorParentVendorId: o.operatorParentVendorId,
        aliasOfVendorId: o.aliasOfVendorId,
        displayOverridePermitted: o.displayOverridePermitted,
        displayMode: o.displayMode,
        defaultChildDisplay: o.defaultChildDisplay,
      });
      officesByBrandId.set(o.brandParentVendorId, arr);
    }

    const cards = groupVendorsForListing({
      matchedVendors: groupableMatches,
      brandParentsById: brandParentsForGrouping,
      officesByBrandId,
    });

    // ── End EH2.2 grouping. Below: existing event fetch, now keyed on
    // the UNION of all vendor ids whose events the cards reference. ─

    // Query 2: Get all upcoming events for all vendors
    // D1 has a limit on SQL bind variables, so batch large arrays
    // EH2.2: vendor ids now include offices of collapsed brands so the
    // aggregated events surface on the brand card.
    const vendorIdsSet = new Set<string>();
    for (const card of cards) {
      for (const id of card.aggregatedEventVendorIds) vendorIdsSet.add(id);
    }
    const vendorIds = [...vendorIdsSet];
    const BATCH_SIZE = 50;
    const allVendorEvents: {
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
    }[] = [];

    for (let i = 0; i < vendorIds.length; i += BATCH_SIZE) {
      const batch = vendorIds.slice(i, i + BATCH_SIZE);
      const batchResults = await db
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
        .where(
          and(
            inArray(eventVendors.vendorId, batch),
            isPublicVendorStatus(),
            isPublicEventStatus(),
            // A2 (Dev backlog 2026-06-05): 24h end-of-day grace.
            upcomingEndPredicate(new Date())
          )
        )
        .orderBy(asc(events.startDate));
      allVendorEvents.push(...batchResults);
    }

    // Group events by vendor ID in memory
    const eventsByVendor = new Map<string, typeof allVendorEvents>();
    for (const event of allVendorEvents) {
      const existing = eventsByVendor.get(event.vendorId) || [];
      existing.push(event);
      eventsByVendor.set(event.vendorId, existing);
    }

    // EH2.2 — build the result list from the card descriptors, not from
    // vendorResults directly. Each card's canonical row is what renders;
    // its aggregatedEventVendorIds drive the events shown on that card.
    type AllVendorEvent = (typeof allVendorEvents)[number];
    let result = cards
      .map((card) => {
        const v = vendorRowById.get(card.vendorId);
        if (!v) return null;

        // Aggregate events over the card's vendor-id set. Dedup by event
        // id (an event could appear under multiple offices of the same
        // brand if it's a multi-office sponsorship, though the schema
        // doesn't currently allow it — defensive).
        const eventById = new Map<string, AllVendorEvent>();
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
          // EH2.2 — flag set on brand-collapsed cards so the UI can show
          // a subtle "X offices" indicator if/when we want one. v1 leaves
          // the card visually identical; the flag is plumbing for v2.
          isBrandCollapsed: card.isBrandCollapsed,
          // Aggregated office count (for brand-collapsed cards). When
          // not collapsed, the field is omitted.
          officeCount: card.isBrandCollapsed
            ? (officesByBrandId.get(v.id)?.length ?? 0)
            : undefined,
          events: aggregatedEvents.map((e) => ({
            id: e.eventId,
            name: e.eventName,
            slug: e.eventSlug,
            startDate: e.startDate,
            endDate: e.endDate,
            imageUrl: e.imageUrl,
            venue: e.venueName
              ? {
                  name: e.venueName,
                  city: e.venueCity,
                  state: e.venueState,
                }
              : null,
          })),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    // Filter by hasEvents if requested
    if (searchParams.hasEvents === "true") {
      result = result.filter((v) => v.events.length > 0);
    }

    return result;
  } catch (e) {
    await logError(db, {
      message: "Error fetching vendors",
      error: e,
      source: "app/vendors/page.tsx:getVendors",
      context: { searchParams },
    });
    // K2 (2026-06-06): throw FetchError so error.tsx renders + HTTP 500
    // bubbles to the edge. Mirrors REL1' §1 pattern in events/page.tsx.
    const { FetchError } = await import("@/lib/errors/fetch-error");
    throw new FetchError("app/vendors/page.tsx:getVendors", e);
  }
}

async function getVendorTypes() {
  const db = getCloudflareDb();

  try {
    const results = await db
      .selectDistinct({ vendorType: vendors.vendorType })
      .from(vendors)
      .where(isNotNull(vendors.vendorType));

    return results
      .map((v) => v.vendorType)
      .filter((t): t is string => t !== null)
      .sort();
  } catch (e) {
    await logError(db, {
      message: "Error fetching vendor types",
      error: e,
      source: "app/vendors/page.tsx:getVendorTypes",
    });
    const { FetchError } = await import("@/lib/errors/fetch-error");
    throw new FetchError("app/vendors/page.tsx:getVendorTypes", e);
  }
}

/**
 * Pull all Enhanced-Profile vendors (optionally filtered to a category) for
 * the Featured Vendors section. The component handles the daily rotation
 * and caps to 6; we hand over the full eligible set so the rotation can
 * shuffle across the full pool, not just whatever fits in 6 slots.
 */
async function getFeaturedVendors(typeFilter?: string): Promise<FeaturedVendor[]> {
  const db = getCloudflareDb();
  const conditions: (ReturnType<typeof eq> | ReturnType<typeof isNull>)[] = [
    eq(vendors.enhancedProfile, true),
    isNull(vendors.deletedAt),
  ];
  if (typeFilter) conditions.push(eq(vendors.vendorType, typeFilter));

  try {
    const rows = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        slug: vendors.slug,
        vendorType: vendors.vendorType,
        city: vendors.city,
        state: vendors.state,
        logoUrl: vendors.logoUrl,
        featuredPriority: vendors.featuredPriority,
        claimed: vendors.claimed,
        enhancedProfile: vendors.enhancedProfile,
        verifiedPro: vendors.verifiedPro,
      })
      .from(vendors)
      .where(and(...conditions));
    return rows;
  } catch (e) {
    await logError(db, {
      message: "Error fetching featured vendors",
      error: e,
      source: "app/vendors/page.tsx:getFeaturedVendors",
    });
    const { FetchError } = await import("@/lib/errors/fetch-error");
    throw new FetchError("app/vendors/page.tsx:getFeaturedVendors", e);
  }
}

export const dynamic = "force-dynamic";

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const session = await auth();
  const isLoggedIn = !!session?.user?.id;

  const favoriteUserId = isLoggedIn && params.favorites === "true" ? session.user.id : undefined;

  const [vendorList, vendorTypes, featuredVendors] = await Promise.all([
    getVendors(params, favoriteUserId),
    getVendorTypes(),
    getFeaturedVendors(params.type),
  ]);

  const currentPage = Math.max(1, parseInt(params.page ?? "1", 10) || 1);
  const totalCount = vendorList.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pageVendors = vendorList.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const hasFilters = params.type || params.q || params.favorites || params.hasEvents;
  const showingFavorites = params.favorites === "true";
  const showingWithEvents = params.hasEvents === "true";

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Vendors", url: "https://meetmeatthefair.com/vendors" },
        ]}
      />
      <ItemListSchema
        name="Fair & Festival Vendors"
        description="Artisans, food vendors, and businesses at fairs and festivals"
        items={pageVendors.map((v) => ({
          name: v.businessName,
          url: `https://meetmeatthefair.com/vendors/${v.slug}`,
          image: v.logoUrl,
        }))}
        totalCount={totalCount}
        positionStart={(currentPage - 1) * PAGE_SIZE + 1}
        asCollectionPage
        pageUrl="https://meetmeatthefair.com/vendors"
      />
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-foreground">Vendor Directory</h1>
        <p className="mt-2 text-muted-foreground">
          Meet the artisans, food vendors, and businesses at our events
          {totalCount > 0 && (
            <span className="ml-1 text-muted-foreground">
              ({totalCount.toLocaleString()} {totalCount === 1 ? "vendor" : "vendors"})
            </span>
          )}
        </p>
      </div>

      <FeaturedVendorsSection vendors={featuredVendors} />

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        <aside className="lg:col-span-1">
          <MobileFilterDrawer>
            <div className="bg-stone-50 p-5 rounded-xl border border-stone-100 space-y-6 lg:sticky lg:top-24">
              <h2 className="text-base font-semibold text-stone-900 pb-2 border-b border-stone-100">
                Filter vendors
              </h2>
              {/* Search */}
              <div>
                <h3 className="font-medium text-stone-900 mb-3">Search</h3>
                <form method="GET" action="/vendors">
                  {params.type && <input type="hidden" name="type" value={params.type} />}
                  {params.hasEvents && (
                    <input type="hidden" name="hasEvents" value={params.hasEvents} />
                  )}
                  {params.favorites && (
                    <input type="hidden" name="favorites" value={params.favorites} />
                  )}
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input
                      type="text"
                      name="q"
                      defaultValue={params.q || ""}
                      placeholder="Search vendors..."
                      className="w-full pl-10 pr-4 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-royal focus:border-royal"
                    />
                  </div>
                </form>
              </div>

              {/* Type Filter */}
              <div>
                <h3 className="font-medium text-foreground mb-3">Filter by Type</h3>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  <Link
                    href={`/vendors${buildQueryString({ q: params.q, hasEvents: params.hasEvents, favorites: params.favorites })}`}
                    className={`block px-3 py-2 rounded-lg text-sm ${
                      !params.type
                        ? "bg-amber-light text-amber-bg-fg font-medium"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    All Types
                  </Link>
                  {vendorTypes.map((type) => (
                    <Link
                      key={type}
                      href={`/vendors${buildQueryString({ type, q: params.q, hasEvents: params.hasEvents, favorites: params.favorites })}`}
                      className={`block px-3 py-2 rounded-lg text-sm ${
                        params.type === type
                          ? "bg-amber-light text-amber-bg-fg font-medium"
                          : "text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {type}
                    </Link>
                  ))}
                </div>
              </div>

              {/* Has Events Filter */}
              <div>
                <h3 className="font-medium text-foreground mb-3">Events</h3>
                {showingWithEvents ? (
                  <Link
                    href={`/vendors${buildQueryString({ type: params.type, q: params.q, favorites: params.favorites })}`}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-green-50 text-green-700 font-medium"
                  >
                    <Calendar className="w-4 h-4" />
                    With Upcoming Events
                  </Link>
                ) : (
                  <Link
                    href={`/vendors${buildQueryString({ type: params.type, q: params.q, hasEvents: "true", favorites: params.favorites })}`}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-muted"
                  >
                    <Calendar className="w-4 h-4" />
                    With Upcoming Events
                  </Link>
                )}
              </div>

              {/* Favorites Filter */}
              {isLoggedIn && (
                <div>
                  <h3 className="font-medium text-foreground mb-3">Favorites</h3>
                  {showingFavorites ? (
                    <Link
                      href={`/vendors${buildQueryString({ type: params.type, q: params.q, hasEvents: params.hasEvents })}`}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-pink-50 text-pink-700 font-medium"
                    >
                      <Heart className="w-4 h-4 fill-current" />
                      Showing Favorites
                    </Link>
                  ) : (
                    <Link
                      href={`/vendors${buildQueryString({ type: params.type, q: params.q, hasEvents: params.hasEvents, favorites: "true" })}`}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-muted"
                    >
                      <Heart className="w-4 h-4" />
                      My Favorites
                    </Link>
                  )}
                </div>
              )}

              {/* Clear Filters */}
              {hasFilters && (
                <Link
                  href="/vendors"
                  className="flex items-center justify-center gap-2 w-full px-4 py-2 text-sm font-medium text-foreground bg-muted hover:bg-muted rounded-lg transition-colors"
                >
                  <X className="w-4 h-4" />
                  Clear Filters
                </Link>
              )}
            </div>
          </MobileFilterDrawer>
        </aside>

        <main className="lg:col-span-3">
          <VendorsView
            vendors={pageVendors}
            emptyMessage={
              showingFavorites
                ? "You haven't favorited any vendors yet."
                : hasFilters
                  ? "No vendors found matching your criteria."
                  : "No vendors available at this time."
            }
          />
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            basePath="/vendors"
            searchParams={{
              type: params.type,
              favorites: params.favorites,
              hasEvents: params.hasEvents,
              q: params.q,
            }}
          />
        </main>
      </div>
    </div>
  );
}
