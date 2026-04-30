import type { Metadata } from "next";
import Link from "next/link";
import { Search, X, Heart, Calendar } from "lucide-react";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, users, eventVendors, events, venues, userFavorites } from "@/lib/db/schema";
import { eq, and, gte, asc, isNotNull, inArray, sql } from "drizzle-orm";
import { isPublicVendorStatus } from "@/lib/vendor-status";
import { isPublicEventStatus } from "@/lib/event-status";
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

export const runtime = "edge";
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
    // Build conditions
    const conditions: ReturnType<typeof eq>[] = [];
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

    // Query 1: Get all vendors (optionally filtered by type and/or favorites)
    let vendorQuery;
    if (conditions.length > 0) {
      vendorQuery = db
        .select()
        .from(vendors)
        .leftJoin(users, eq(vendors.userId, users.id))
        .where(and(...conditions))
        .orderBy(vendors.businessName);
    } else {
      vendorQuery = db
        .select()
        .from(vendors)
        .leftJoin(users, eq(vendors.userId, users.id))
        .orderBy(vendors.businessName);
    }

    let vendorResults = await vendorQuery;

    // Filter by search query if provided
    if (searchParams.q) {
      const lowerQuery = searchParams.q.toLowerCase();
      vendorResults = vendorResults.filter(
        (v) =>
          v.vendors.businessName.toLowerCase().includes(lowerQuery) ||
          v.vendors.description?.toLowerCase().includes(lowerQuery) ||
          v.vendors.vendorType?.toLowerCase().includes(lowerQuery)
      );
    }

    if (vendorResults.length === 0) {
      return [];
    }

    // Query 2: Get all upcoming events for all vendors
    // D1 has a limit on SQL bind variables, so batch large arrays
    const vendorIds = vendorResults.map((v) => v.vendors.id);
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
            gte(events.endDate, new Date())
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

    // Combine vendors with their events
    let result = vendorResults.map((v) => ({
      id: v.vendors.id,
      businessName: v.vendors.businessName,
      slug: v.vendors.slug,
      description: v.vendors.description,
      vendorType: v.vendors.vendorType,
      products: v.vendors.products,
      logoUrl: v.vendors.logoUrl,
      website: v.vendors.website,
      verified: v.vendors.verified,
      commercial: v.vendors.commercial,
      city: v.vendors.city,
      state: v.vendors.state,
      events: (eventsByVendor.get(v.vendors.id) || []).map((e) => ({
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
    }));

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
    return [];
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
    return [];
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
  const conditions: ReturnType<typeof eq>[] = [eq(vendors.enhancedProfile, true)];
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
    return [];
  }
}

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
        asCollectionPage
        pageUrl="https://meetmeatthefair.com/vendors"
      />
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Vendor Directory</h1>
        <p className="mt-2 text-gray-600">
          Meet the artisans, food vendors, and businesses at our events
          {totalCount > 0 && (
            <span className="ml-1 text-gray-500">
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
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input
                      type="text"
                      name="q"
                      defaultValue={params.q || ""}
                      placeholder="Search vendors..."
                      className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-royal focus:border-royal"
                    />
                  </div>
                </form>
              </div>

              {/* Type Filter */}
              <div>
                <h3 className="font-medium text-gray-900 mb-3">Filter by Type</h3>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  <Link
                    href={`/vendors${buildQueryString({ q: params.q, hasEvents: params.hasEvents, favorites: params.favorites })}`}
                    className={`block px-3 py-2 rounded-lg text-sm ${
                      !params.type
                        ? "bg-amber-light text-amber-dark font-medium"
                        : "text-gray-600 hover:bg-gray-50"
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
                          ? "bg-amber-light text-amber-dark font-medium"
                          : "text-gray-600 hover:bg-gray-50"
                      }`}
                    >
                      {type}
                    </Link>
                  ))}
                </div>
              </div>

              {/* Has Events Filter */}
              <div>
                <h3 className="font-medium text-gray-900 mb-3">Events</h3>
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
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
                  >
                    <Calendar className="w-4 h-4" />
                    With Upcoming Events
                  </Link>
                )}
              </div>

              {/* Favorites Filter */}
              {isLoggedIn && (
                <div>
                  <h3 className="font-medium text-gray-900 mb-3">Favorites</h3>
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
                      className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
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
                  className="flex items-center justify-center gap-2 w-full px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
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
