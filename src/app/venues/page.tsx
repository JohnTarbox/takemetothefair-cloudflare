import type { Metadata } from "next";
import Link from "next/link";
import { Search, X, Heart, Calendar, Filter } from "lucide-react";
import { getCloudflareDb } from "@/lib/cloudflare";
import { venues, userFavorites } from "@/lib/db/schema";
import { eq, and, sql, isNotNull, isNull } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { VenuesView } from "@/components/venues/venues-view";
import { logError } from "@/lib/logger";
import { ItemListSchema } from "@/components/seo/ItemListSchema";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";

export const runtime = "edge";
export const revalidate = 3600; // Cache for 1 hour

export const metadata: Metadata = {
  title: "Fair & Festival Venues | Meet Me at the Fair",
  description:
    "Discover fairgrounds and event spaces hosting upcoming fairs, festivals, and community events.",
  alternates: { canonical: "https://meetmeatthefair.com/venues" },
  openGraph: {
    title: "Fair & Festival Venues | Meet Me at the Fair",
    description:
      "Discover fairgrounds and event spaces hosting upcoming fairs, festivals, and community events.",
    url: "https://meetmeatthefair.com/venues",
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
    title: "Fair & Festival Venues | Meet Me at the Fair",
    description:
      "Discover fairgrounds and event spaces hosting upcoming fairs, festivals, and community events.",
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
  state?: string;
  q?: string;
  favorites?: string;
  hasEvents?: string;
  missingGoogle?: string;
}

async function getVenues(searchParams: SearchParams, favoriteUserId?: string) {
  const db = getCloudflareDb();

  try {
    // Build conditions
    const conditions = [eq(venues.status, "ACTIVE")];

    if (searchParams.state) {
      conditions.push(eq(venues.state, searchParams.state));
    }

    if (searchParams.q) {
      conditions.push(
        sql`(${venues.name} LIKE ${"%" + searchParams.q + "%"} OR ${venues.city} LIKE ${"%" + searchParams.q + "%"})`
      );
    }

    // Use subquery for favorites filter (avoids D1 bind parameter limit)
    if (searchParams.favorites === "true" && favoriteUserId) {
      conditions.push(
        sql`${venues.id} IN (SELECT ${userFavorites.favoritableId} FROM ${userFavorites} WHERE ${userFavorites.userId} = ${favoriteUserId} AND ${userFavorites.favoritableType} = 'VENUE')`
      );
    } else if (searchParams.favorites === "true" && !favoriteUserId) {
      return [];
    }

    // Single query: Get venues with event counts using subquery
    const eventCountSubquery = sql<number>`(
      SELECT COUNT(*) FROM events
      WHERE events.venue_id = venues.id
      AND events.status = 'APPROVED'
      AND events.end_date >= unixepoch('now')
    )`;

    if (searchParams.missingGoogle === "true") {
      conditions.push(isNull(venues.googlePlaceId));
    }

    // Add hasEvents filter condition if requested
    if (searchParams.hasEvents === "true") {
      conditions.push(sql`${eventCountSubquery} > 0`);
    }

    const venuesWithCounts = await db
      .select({
        id: venues.id,
        name: venues.name,
        slug: venues.slug,
        address: venues.address,
        city: venues.city,
        state: venues.state,
        zip: venues.zip,
        capacity: venues.capacity,
        amenities: venues.amenities,
        imageUrl: venues.imageUrl,
        website: venues.website,
        eventCount: eventCountSubquery.as("event_count"),
      })
      .from(venues)
      .where(and(...conditions))
      .orderBy(venues.name);

    return venuesWithCounts.map((venue) => ({
      id: venue.id,
      name: venue.name,
      slug: venue.slug,
      address: venue.address,
      city: venue.city,
      state: venue.state,
      zip: venue.zip,
      capacity: venue.capacity,
      amenities: venue.amenities,
      imageUrl: venue.imageUrl,
      website: venue.website,
      _count: {
        events: venue.eventCount || 0,
      },
    }));
  } catch (e) {
    await logError(db, {
      message: "Error fetching venues",
      error: e,
      source: "app/venues/page.tsx:getVenues",
      context: { searchParams },
    });
    return [];
  }
}

async function getStates() {
  const db = getCloudflareDb();

  try {
    const results = await db
      .selectDistinct({ state: venues.state })
      .from(venues)
      .where(and(eq(venues.status, "ACTIVE"), isNotNull(venues.state)));

    return results
      .map((v) => v.state)
      .filter((s): s is string => s !== null)
      .sort();
  } catch (e) {
    await logError(db, {
      message: "Error fetching states",
      error: e,
      source: "app/venues/page.tsx:getStates",
    });
    return [];
  }
}

export default async function VenuesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const session = await auth();
  const isLoggedIn = !!session?.user?.id;
  const isAdmin = session?.user?.role === "ADMIN";

  const favoriteUserId = isLoggedIn && params.favorites === "true" ? session.user.id : undefined;

  const [venueList, states] = await Promise.all([getVenues(params, favoriteUserId), getStates()]);

  const hasFilters =
    params.state || params.q || params.favorites || params.hasEvents || params.missingGoogle;
  const showingFavorites = params.favorites === "true";
  const showingWithEvents = params.hasEvents === "true";
  const showingMissingGoogle = params.missingGoogle === "true";

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Venues", url: "https://meetmeatthefair.com/venues" },
        ]}
      />
      <ItemListSchema
        name="Fair & Festival Venues"
        description="Fairgrounds and event spaces hosting upcoming events"
        items={venueList.map((v) => ({
          name: v.name,
          url: `https://meetmeatthefair.com/venues/${v.slug}`,
          image: v.imageUrl,
        }))}
        totalCount={venueList.length}
        asCollectionPage
        pageUrl="https://meetmeatthefair.com/venues"
      />
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Venues</h1>
        <p className="mt-2 text-gray-600">
          Discover fairgrounds and event spaces hosting upcoming events
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        <aside className="lg:col-span-1">
          <div className="bg-white p-4 rounded-lg border border-gray-200 space-y-6">
            {/* Search */}
            <div>
              <h3 className="font-medium text-gray-900 mb-3">Search</h3>
              <form method="GET" action="/venues">
                {params.state && <input type="hidden" name="state" value={params.state} />}
                {params.hasEvents && (
                  <input type="hidden" name="hasEvents" value={params.hasEvents} />
                )}
                {params.favorites && (
                  <input type="hidden" name="favorites" value={params.favorites} />
                )}
                {params.missingGoogle && (
                  <input type="hidden" name="missingGoogle" value={params.missingGoogle} />
                )}
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    name="q"
                    defaultValue={params.q || ""}
                    placeholder="Search venues..."
                    className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-royal focus:border-royal"
                  />
                </div>
              </form>
            </div>

            {/* State Filter */}
            <div>
              <h3 className="font-medium text-gray-900 mb-3">Filter by State</h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                <Link
                  href={`/venues${buildQueryString({ q: params.q, hasEvents: params.hasEvents, favorites: params.favorites, missingGoogle: params.missingGoogle })}`}
                  className={`block px-3 py-2 rounded-lg text-sm ${
                    !params.state
                      ? "bg-brand-blue-light text-royal font-medium"
                      : "text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  All States
                </Link>
                {states.map((state) => (
                  <Link
                    key={state}
                    href={`/venues${buildQueryString({ state, q: params.q, hasEvents: params.hasEvents, favorites: params.favorites, missingGoogle: params.missingGoogle })}`}
                    className={`block px-3 py-2 rounded-lg text-sm ${
                      params.state === state
                        ? "bg-brand-blue-light text-royal font-medium"
                        : "text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    {state}
                  </Link>
                ))}
              </div>
            </div>

            {/* Has Events Filter */}
            <div>
              <h3 className="font-medium text-gray-900 mb-3">Events</h3>
              {showingWithEvents ? (
                <Link
                  href={`/venues${buildQueryString({ state: params.state, q: params.q, favorites: params.favorites, missingGoogle: params.missingGoogle })}`}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-green-50 text-green-700 font-medium"
                >
                  <Calendar className="w-4 h-4" />
                  With Upcoming Events
                </Link>
              ) : (
                <Link
                  href={`/venues${buildQueryString({ state: params.state, q: params.q, hasEvents: "true", favorites: params.favorites })}`}
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
                    href={`/venues${buildQueryString({ state: params.state, q: params.q, hasEvents: params.hasEvents, missingGoogle: params.missingGoogle })}`}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-pink-50 text-pink-700 font-medium"
                  >
                    <Heart className="w-4 h-4 fill-current" />
                    Showing Favorites
                  </Link>
                ) : (
                  <Link
                    href={`/venues${buildQueryString({ state: params.state, q: params.q, hasEvents: params.hasEvents, favorites: "true" })}`}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
                  >
                    <Heart className="w-4 h-4" />
                    My Favorites
                  </Link>
                )}
              </div>
            )}

            {/* Admin: Missing Google Place ID Filter */}
            {isAdmin && (
              <div>
                <h3 className="font-medium text-gray-900 mb-3">Admin</h3>
                {showingMissingGoogle ? (
                  <Link
                    href={`/venues${buildQueryString({ state: params.state, q: params.q, hasEvents: params.hasEvents, favorites: params.favorites })}`}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-amber-50 text-amber-700 font-medium"
                  >
                    <Filter className="w-4 h-4" />
                    Missing Google ID
                  </Link>
                ) : (
                  <Link
                    href={`/venues${buildQueryString({ state: params.state, q: params.q, hasEvents: params.hasEvents, favorites: params.favorites, missingGoogle: "true" })}`}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
                  >
                    <Filter className="w-4 h-4" />
                    Missing Google ID
                  </Link>
                )}
              </div>
            )}

            {/* Clear Filters */}
            {hasFilters && (
              <Link
                href="/venues"
                className="flex items-center justify-center gap-2 w-full px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
              >
                <X className="w-4 h-4" />
                Clear Filters
              </Link>
            )}
          </div>
        </aside>

        <main className="lg:col-span-3">
          <VenuesView
            venues={venueList}
            emptyMessage={
              showingFavorites
                ? "You haven't favorited any venues yet."
                : hasFilters
                  ? "No venues found matching your criteria."
                  : "No venues available at this time."
            }
          />
        </main>
      </div>
    </div>
  );
}
