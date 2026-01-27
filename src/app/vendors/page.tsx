import Link from "next/link";
import Image from "next/image";
import { Store, CheckCircle, Calendar, MapPin, Heart } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, users, eventVendors, events, venues, userFavorites } from "@/lib/db/schema";
import { eq, and, gte, isNotNull, inArray } from "drizzle-orm";
import { parseJsonArray } from "@/types";
import { formatDateRange } from "@/lib/utils";
import { auth } from "@/lib/auth";

export const runtime = "edge";
export const revalidate = 3600; // Cache for 1 hour


interface SearchParams {
  type?: string;
  favorites?: string;
}

async function getUserFavoriteIds(userId: string): Promise<string[]> {
  try {
    const db = getCloudflareDb();
    const favorites = await db
      .select({ favoritableId: userFavorites.favoritableId })
      .from(userFavorites)
      .where(and(eq(userFavorites.userId, userId), eq(userFavorites.favoritableType, "VENDOR")));
    return favorites.map((f) => f.favoritableId);
  } catch {
    return [];
  }
}

async function getVendors(searchParams: SearchParams, favoriteIds?: string[]) {
  try {
    const db = getCloudflareDb();

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

    const vendorResults = await vendorQuery;

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
    return vendorResults.map(v => ({
      ...v.vendors,
      user: v.users ? { name: v.users.name } : { name: null },
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
  } catch (e) {
    console.error("Error fetching vendors:", e);
    return [];
  }
}

async function getVendorTypes() {
  try {
    const db = getCloudflareDb();
    const results = await db
      .selectDistinct({ vendorType: vendors.vendorType })
      .from(vendors)
      .where(isNotNull(vendors.vendorType));

    return results
      .map((v) => v.vendorType)
      .filter((t): t is string => t !== null)
      .sort();
  } catch (e) {
    console.error("Error fetching vendor types:", e);
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

  const showingFavorites = params.favorites === "true";

  // Build URL preserving type filter when toggling favorites
  const buildUrl = (options: { favorites?: boolean; type?: string }) => {
    const urlParams = new URLSearchParams();
    if (options.type) urlParams.set("type", options.type);
    if (options.favorites) urlParams.set("favorites", "true");
    const queryString = urlParams.toString();
    return queryString ? `/vendors?${queryString}` : "/vendors";
  };

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Vendor Directory</h1>
        <p className="mt-2 text-gray-600">
          Meet the artisans, food vendors, and businesses at our events
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        <aside className="lg:col-span-1">
          <div className="bg-white p-4 rounded-lg border border-gray-200">
            <h3 className="font-medium text-gray-900 mb-3">Filter by Type</h3>
            <div className="space-y-2">
              <Link
                href={buildUrl({ favorites: showingFavorites })}
                className={`block px-3 py-2 rounded-lg text-sm ${
                  !params.type
                    ? "bg-blue-50 text-blue-700 font-medium"
                    : "text-gray-600 hover:bg-gray-50"
                }`}
              >
                All Vendors
              </Link>
              {vendorTypes.map((type) => (
                <Link
                  key={type}
                  href={buildUrl({ type, favorites: showingFavorites })}
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

            {isLoggedIn && (
              <>
                <hr className="my-4 border-gray-200" />
                <Link
                  href={buildUrl({ type: params.type, favorites: !showingFavorites })}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                    showingFavorites
                      ? "bg-pink-50 text-pink-700 font-medium"
                      : "text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  <Heart className={`w-4 h-4 ${showingFavorites ? "fill-current" : ""}`} />
                  My Favorites
                </Link>
              </>
            )}
          </div>
        </aside>

        <main className="lg:col-span-3">
          {vendorList.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-500">
                {showingFavorites
                  ? "You haven't favorited any vendors yet."
                  : "No vendors found."}
              </p>
            </div>
          ) : (
            <div className="space-y-8">
              {vendorList.map((vendor) => {
                const products = parseJsonArray(vendor.products);
                return (
                  <Card key={vendor.id} className="overflow-hidden">
                    <div className="p-6">
                      <Link href={`/vendors/${vendor.slug}`} className="flex gap-4 hover:opacity-80 transition-opacity">
                        <div className="w-16 h-16 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0 relative overflow-hidden">
                          {vendor.logoUrl ? (
                            <Image
                              src={vendor.logoUrl}
                              alt={vendor.businessName}
                              fill
                              sizes="64px"
                              className="object-cover"
                            />
                          ) : (
                            <Store className="w-8 h-8 text-gray-400" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="font-semibold text-gray-900 truncate">
                              {vendor.businessName}
                            </h3>
                            {vendor.verified && (
                              <CheckCircle className="w-4 h-4 text-blue-600 flex-shrink-0" />
                            )}
                            {vendor.commercial && (
                              <Badge variant="default">Commercial</Badge>
                            )}
                          </div>
                          {vendor.vendorType && (
                            <p className="text-sm text-gray-500 mt-1">
                              {vendor.vendorType}
                            </p>
                          )}
                          {vendor.description && (
                            <p className="text-sm text-gray-600 mt-2 line-clamp-2">
                              {vendor.description}
                            </p>
                          )}
                          {products.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {products.slice(0, 3).map((product) => (
                                <Badge key={product} variant="default">
                                  {product}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                      </Link>

                      {/* Events Grid */}
                      {vendor.events.length > 0 && (
                        <div className="mt-6 pt-6 border-t border-gray-100">
                          <h4 className="text-sm font-medium text-gray-900 mb-3 flex items-center gap-2">
                            <Calendar className="w-4 h-4" />
                            Upcoming Events ({vendor.events.length})
                          </h4>
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            {vendor.events.map((event) => (
                              <Link
                                key={event.id}
                                href={`/events/${event.slug}`}
                                className="block p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
                              >
                                {event.imageUrl && (
                                  <div className="aspect-video rounded-md overflow-hidden mb-2 relative">
                                    <Image
                                      src={event.imageUrl}
                                      alt={event.name}
                                      fill
                                      sizes="(max-width: 640px) 100vw, 200px"
                                      className="object-cover"
                                    />
                                  </div>
                                )}
                                <p className="font-medium text-gray-900 text-sm truncate">
                                  {event.name}
                                </p>
                                <p className="text-xs text-gray-500 mt-1">
                                  {formatDateRange(event.startDate, event.endDate)}
                                </p>
                                {event.venue && (
                                  <p className="text-xs text-gray-500 flex items-center gap-1 mt-1">
                                    <MapPin className="w-3 h-3" />
                                    {event.venue.city}, {event.venue.state}
                                  </p>
                                )}
                              </Link>
                            ))}
                          </div>
                        </div>
                      )}

                      {vendor.events.length === 0 && (
                        <p className="mt-4 text-xs text-gray-500">
                          No upcoming events scheduled
                        </p>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
