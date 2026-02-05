import type { Metadata } from "next";
import Link from "next/link";
import { Search, X, Heart, Calendar } from "lucide-react";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, users, eventVendors, events, venues, userFavorites } from "@/lib/db/schema";
import { eq, and, gte, isNotNull, inArray } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { VendorsView } from "@/components/vendors/vendors-view";
import { logError } from "@/lib/logger";
import { ItemListSchema } from "@/components/seo/ItemListSchema";

export const runtime = "edge";
export const revalidate = 3600; // Cache for 1 hour

export const metadata: Metadata = {
  title: "Fair & Festival Vendors | Meet Me at the Fair",
  description: "Meet the artisans, food vendors, and businesses participating in fairs and festivals.",
  alternates: { canonical: "https://meetmeatthefair.com/vendors" },
  openGraph: {
    title: "Fair & Festival Vendors | Meet Me at the Fair",
    description: "Meet the artisans, food vendors, and businesses participating in fairs and festivals.",
    url: "https://meetmeatthefair.com/vendors",
    siteName: "Meet Me at the Fair",
    type: "website",
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
}

async function getUserFavoriteIds(userId: string): Promise<string[]> {
  try {
    const db = getCloudflareDb();
    const favorites = await db
      .select({ favoritableId: userFavorites.favoritableId })
      .from(userFavorites)
      .where(and(eq(userFavorites.userId, userId), eq(userFavorites.favoritableType, "VENDOR")));
    return favorites.map((f) => f.favoritableId);
  } catch (error) {
    console.error("Failed to fetch user favorite vendor IDs", { error, userId });
    return [];
  }
}

async function getVendors(searchParams: SearchParams, favoriteIds?: string[]) {
  const db = getCloudflareDb();

  try {

    // Build conditions
    const conditions: ReturnType<typeof eq>[] = [];
    if (searchParams.type) {
      conditions.push(eq(vendors.vendorType, searchParams.type));
    }
    if (searchParams.favorites === "true" && favoriteIds && favoriteIds.length > 0) {
      conditions.push(inArray(vendors.id, favoriteIds));
    } else if (searchParams.favorites === "true" && (!favoriteIds || favoriteIds.length === 0)) {
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
      vendorResults = vendorResults.filter(v =>
        v.vendors.businessName.toLowerCase().includes(lowerQuery) ||
        v.vendors.description?.toLowerCase().includes(lowerQuery) ||
        v.vendors.vendorType?.toLowerCase().includes(lowerQuery)
      );
    }

    if (vendorResults.length === 0) {
      return [];
    }

    // Query 2: Get all upcoming events for all vendors in a single query
    const vendorIds = vendorResults.map(v => v.vendors.id);
    const allVendorEvents = await db
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
          inArray(eventVendors.vendorId, vendorIds),
          eq(eventVendors.status, "APPROVED"),
          eq(events.status, "APPROVED"),
          gte(events.endDate, new Date())
        )
      );

    // Group events by vendor ID in memory
    const eventsByVendor = new Map<string, typeof allVendorEvents>();
    for (const event of allVendorEvents) {
      const existing = eventsByVendor.get(event.vendorId) || [];
      existing.push(event);
      eventsByVendor.set(event.vendorId, existing);
    }

    // Combine vendors with their events
    let result = vendorResults.map(v => ({
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
      events: (eventsByVendor.get(v.vendors.id) || []).map(e => ({
        id: e.eventId,
        name: e.eventName,
        slug: e.eventSlug,
        startDate: e.startDate,
        endDate: e.endDate,
        imageUrl: e.imageUrl,
        venue: e.venueName ? {
          name: e.venueName,
          city: e.venueCity,
          state: e.venueState,
        } : null,
      })),
    }));

    // Filter by hasEvents if requested
    if (searchParams.hasEvents === "true") {
      result = result.filter(v => v.events.length > 0);
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

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const session = await auth();
  const isLoggedIn = !!session?.user?.id;

  let favoriteIds: string[] | undefined;
  if (isLoggedIn && params.favorites === "true") {
    favoriteIds = await getUserFavoriteIds(session.user.id);
  }

  const [vendorList, vendorTypes] = await Promise.all([
    getVendors(params, favoriteIds),
    getVendorTypes(),
  ]);

  const hasFilters = params.type || params.q || params.favorites || params.hasEvents;
  const showingFavorites = params.favorites === "true";
  const showingWithEvents = params.hasEvents === "true";

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <ItemListSchema
        name="Fair & Festival Vendors"
        description="Artisans, food vendors, and businesses at fairs and festivals"
        items={vendorList.map((v) => ({
          name: v.businessName,
          url: `https://meetmeatthefair.com/vendors/${v.slug}`,
          image: v.logoUrl,
        }))}
      />
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Vendor Directory</h1>
        <p className="mt-2 text-gray-600">
          Meet the artisans, food vendors, and businesses at our events
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        <aside className="lg:col-span-1">
          <div className="bg-white p-4 rounded-lg border border-gray-200 space-y-6">
            {/* Search */}
            <div>
              <h3 className="font-medium text-gray-900 mb-3">Search</h3>
              <form method="GET" action="/vendors">
                {params.type && (
                  <input type="hidden" name="type" value={params.type} />
                )}
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
                    className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
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
                      ? "bg-blue-50 text-blue-700 font-medium"
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
                        ? "bg-blue-50 text-blue-700 font-medium"
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
        </aside>

        <main className="lg:col-span-3">
          <VendorsView
            vendors={vendorList}
            emptyMessage={
              showingFavorites
                ? "You haven't favorited any vendors yet."
                : hasFilters
                  ? "No vendors found matching your criteria."
                  : "No vendors available at this time."
            }
          />
        </main>
      </div>
    </div>
  );
}
