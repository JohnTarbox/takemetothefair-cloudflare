import Link from "next/link";
import { Store, CheckCircle, Calendar, MapPin } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, users, eventVendors, events, venues } from "@/lib/db/schema";
import { eq, and, gte, isNotNull } from "drizzle-orm";
import { parseJsonArray } from "@/types";
import { formatDateRange } from "@/lib/utils";

export const runtime = "edge";
export const dynamic = "force-dynamic";


interface SearchParams {
  type?: string;
}

async function getVendors(searchParams: SearchParams) {
  try {
    const db = getCloudflareDb();

    // Get all vendors (optionally filtered by type)
    let vendorQuery = db
      .select()
      .from(vendors)
      .leftJoin(users, eq(vendors.userId, users.id))
      .orderBy(vendors.businessName);

    if (searchParams.type) {
      vendorQuery = db
        .select()
        .from(vendors)
        .leftJoin(users, eq(vendors.userId, users.id))
        .where(eq(vendors.vendorType, searchParams.type))
        .orderBy(vendors.businessName);
    }

    const vendorResults = await vendorQuery;

    // Get events for each vendor
    const vendorsWithEvents = await Promise.all(
      vendorResults.map(async (v) => {
        // Get approved upcoming events for this vendor
        const vendorEvents = await db
          .select()
          .from(eventVendors)
          .leftJoin(events, eq(eventVendors.eventId, events.id))
          .leftJoin(venues, eq(events.venueId, venues.id))
          .where(
            and(
              eq(eventVendors.vendorId, v.vendors.id),
              eq(eventVendors.status, "APPROVED"),
              eq(events.status, "APPROVED"),
              gte(events.endDate, new Date())
            )
          );

        return {
          ...v.vendors,
          user: v.users ? { name: v.users.name } : { name: null },
          events: vendorEvents
            .filter((e) => e.events !== null)
            .map((e) => ({
              id: e.events!.id,
              name: e.events!.name,
              slug: e.events!.slug,
              startDate: e.events!.startDate,
              endDate: e.events!.endDate,
              imageUrl: e.events!.imageUrl,
              venue: e.venues ? {
                name: e.venues.name,
                city: e.venues.city,
                state: e.venues.state,
              } : null,
            })),
        };
      })
    );

    return vendorsWithEvents;
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
  const [vendorList, vendorTypes] = await Promise.all([
    getVendors(params),
    getVendorTypes(),
  ]);

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
                href="/vendors"
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
                  href={`/vendors?type=${encodeURIComponent(type)}`}
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
        </aside>

        <main className="lg:col-span-3">
          {vendorList.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-500">No vendors found.</p>
            </div>
          ) : (
            <div className="space-y-8">
              {vendorList.map((vendor) => {
                const products = parseJsonArray(vendor.products);
                return (
                  <Card key={vendor.id} className="overflow-hidden">
                    <div className="p-6">
                      <Link href={`/vendors/${vendor.slug}`} className="flex gap-4 hover:opacity-80 transition-opacity">
                        <div className="w-16 h-16 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
                          {vendor.logoUrl ? (
                            <img
                              src={vendor.logoUrl}
                              alt={vendor.businessName}
                              className="w-16 h-16 rounded-lg object-cover"
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
                                  <div className="aspect-video rounded-md overflow-hidden mb-2">
                                    <img
                                      src={event.imageUrl}
                                      alt={event.name}
                                      className="w-full h-full object-cover"
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
