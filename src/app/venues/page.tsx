import Link from "next/link";
import Image from "next/image";
import { MapPin, Users, Calendar, Search, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getCloudflareDb } from "@/lib/cloudflare";
import { venues, events } from "@/lib/db/schema";
import { eq, and, like, sql, isNotNull } from "drizzle-orm";
import { parseJsonArray } from "@/types";

export const runtime = "edge";
export const revalidate = 3600; // Cache for 1 hour


interface SearchParams {
  state?: string;
  q?: string;
}

async function getVenues(searchParams: SearchParams) {
  try {
    const db = getCloudflareDb();

    // Build conditions
    const conditions = [eq(venues.status, "ACTIVE")];

    if (searchParams.state) {
      conditions.push(eq(venues.state, searchParams.state));
    }

    if (searchParams.q) {
      conditions.push(
        sql`(${venues.name} LIKE ${'%' + searchParams.q + '%'} OR ${venues.city} LIKE ${'%' + searchParams.q + '%'})`
      );
    }

    // Single query: Get venues with event counts using subquery
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
        eventCount: sql<number>`(
          SELECT COUNT(*) FROM events
          WHERE events.venue_id = ${venues.id}
          AND events.status = 'APPROVED'
          AND events.end_date >= datetime('now')
        )`.as('event_count'),
      })
      .from(venues)
      .where(and(...conditions))
      .orderBy(venues.name);

    return venuesWithCounts.map(venue => ({
      ...venue,
      _count: {
        events: venue.eventCount || 0,
      },
    }));
  } catch (e) {
    console.error("Error fetching venues:", e);
    return [];
  }
}

async function getStates() {
  try {
    const db = getCloudflareDb();
    const results = await db
      .selectDistinct({ state: venues.state })
      .from(venues)
      .where(and(eq(venues.status, "ACTIVE"), isNotNull(venues.state)));

    return results
      .map((v) => v.state)
      .filter((s): s is string => s !== null)
      .sort();
  } catch (e) {
    console.error("Error fetching states:", e);
    return [];
  }
}

export default async function VenuesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const [venueList, states] = await Promise.all([
    getVenues(params),
    getStates(),
  ]);

  const hasFilters = params.state || params.q;

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
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
                {params.state && (
                  <input type="hidden" name="state" value={params.state} />
                )}
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    name="q"
                    defaultValue={params.q || ""}
                    placeholder="Search venues..."
                    className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </form>
            </div>

            {/* State Filter */}
            <div>
              <h3 className="font-medium text-gray-900 mb-3">Filter by State</h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                <Link
                  href={params.q ? `/venues?q=${encodeURIComponent(params.q)}` : "/venues"}
                  className={`block px-3 py-2 rounded-lg text-sm ${
                    !params.state
                      ? "bg-blue-50 text-blue-700 font-medium"
                      : "text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  All States
                </Link>
                {states.map((state) => (
                  <Link
                    key={state}
                    href={`/venues?state=${encodeURIComponent(state)}${params.q ? `&q=${encodeURIComponent(params.q)}` : ""}`}
                    className={`block px-3 py-2 rounded-lg text-sm ${
                      params.state === state
                        ? "bg-blue-50 text-blue-700 font-medium"
                        : "text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    {state}
                  </Link>
                ))}
              </div>
            </div>

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
          {venueList.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-500">
                {hasFilters
                  ? "No venues found matching your criteria."
                  : "No venues available at this time."}
              </p>
              {hasFilters && (
                <Link
                  href="/venues"
                  className="mt-4 inline-block text-blue-600 hover:text-blue-700"
                >
                  Clear filters
                </Link>
              )}
            </div>
          ) : (
            <>
              <p className="text-sm text-gray-500 mb-4">
                {venueList.length} venue{venueList.length !== 1 ? "s" : ""} found
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {venueList.map((venue) => {
                  const amenities = parseJsonArray(venue.amenities);
                  return (
                    <Link key={venue.id} href={`/venues/${venue.slug}`}>
                      <Card className="h-full hover:shadow-md transition-shadow cursor-pointer">
                        <div className="aspect-video relative bg-gray-100">
                          {venue.imageUrl ? (
                            <Image
                              src={venue.imageUrl}
                              alt={venue.name}
                              fill
                              sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
                              className="object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-gray-400">
                              <MapPin className="w-12 h-12" />
                            </div>
                          )}
                        </div>
                        <div className="p-4">
                          <h3 className="font-semibold text-lg text-gray-900">
                            {venue.name}
                          </h3>
                          <div className="mt-2 space-y-1 text-sm text-gray-600">
                            <div className="flex items-center">
                              <MapPin className="w-4 h-4 mr-2 flex-shrink-0" />
                              <span>
                                {venue.city}, {venue.state}
                              </span>
                            </div>
                            {venue.capacity && (
                              <div className="flex items-center">
                                <Users className="w-4 h-4 mr-2 flex-shrink-0" />
                                <span>Capacity: {venue.capacity.toLocaleString()}</span>
                              </div>
                            )}
                            <div className="flex items-center">
                              <Calendar className="w-4 h-4 mr-2 flex-shrink-0" />
                              <span>{venue._count.events} upcoming events</span>
                            </div>
                          </div>
                          {amenities.length > 0 && (
                            <div className="mt-3 flex flex-wrap gap-1">
                              {amenities.slice(0, 3).map((amenity) => (
                                <Badge key={amenity} variant="default">
                                  {amenity}
                                </Badge>
                              ))}
                              {amenities.length > 3 && (
                                <Badge variant="default">
                                  +{amenities.length - 3}
                                </Badge>
                              )}
                            </div>
                          )}
                        </div>
                      </Card>
                    </Link>
                  );
                })}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
