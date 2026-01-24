import { notFound } from "next/navigation";
import Link from "next/link";
import {
  Calendar,
  MapPin,
  Tag,
  ExternalLink,
  Clock,
  User,
  Store,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatDateRange, formatPrice } from "@/lib/utils";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, promoters, eventVendors, vendors, users } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { parseJsonArray } from "@/types";
import type { Metadata } from "next";

export const runtime = "edge";

interface Props {
  params: Promise<{ slug: string }>;
}

async function getEvent(slug: string) {
  try {
    const db = getCloudflareDb();

    // Get event with venue and promoter
    const eventResults = await db
      .select()
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(and(eq(events.slug, slug), eq(events.status, "APPROVED")))
      .limit(1);

    if (eventResults.length === 0) return null;

    const eventData = eventResults[0];

    // Get promoter's user
    const promoterUser = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, eventData.promoters!.userId))
      .limit(1);

    // Get event vendors
    const eventVendorResults = await db
      .select()
      .from(eventVendors)
      .leftJoin(vendors, eq(eventVendors.vendorId, vendors.id))
      .where(and(eq(eventVendors.eventId, eventData.events.id), eq(eventVendors.status, "APPROVED")));

    // Increment view count
    await db
      .update(events)
      .set({ viewCount: sql`${events.viewCount} + 1` })
      .where(eq(events.id, eventData.events.id));

    return {
      ...eventData.events,
      venue: eventData.venues!,
      promoter: {
        ...eventData.promoters!,
        user: promoterUser[0] || { name: null, email: null },
      },
      eventVendors: eventVendorResults.map((ev) => ({
        ...ev.event_vendors,
        vendor: ev.vendors!,
      })),
    };
  } catch (e) {
    console.error("Error fetching event:", e);
    return null;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const event = await getEvent(slug);

  if (!event) {
    return { title: "Event Not Found" };
  }

  return {
    title: `${event.name} | Meet Me at the Fair`,
    description: event.description?.slice(0, 160) || `${event.name} at ${event.venue.name}`,
  };
}

export default async function EventDetailPage({ params }: Props) {
  const { slug } = await params;
  const event = await getEvent(slug);

  if (!event) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <main className="lg:col-span-2 space-y-6">
          {event.imageUrl && (
            <div className="aspect-video rounded-xl overflow-hidden bg-gray-100">
              <img
                src={event.imageUrl}
                alt={event.name}
                className="w-full h-full object-cover"
              />
            </div>
          )}

          {(() => {
            const categories = parseJsonArray(event.categories);
            const tags = parseJsonArray(event.tags);
            return (
              <>
                <div>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {event.featured && <Badge variant="warning">Featured</Badge>}
                    {categories.map((cat) => (
                      <Badge key={cat}>{cat}</Badge>
                    ))}
                  </div>
                  <h1 className="text-3xl md:text-4xl font-bold text-gray-900">
                    {event.name}
                  </h1>
                </div>

                <div className="prose prose-gray max-w-none">
                  <p className="text-gray-600 whitespace-pre-wrap">
                    {event.description || "No description available."}
                  </p>
                </div>

                {tags.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {tags.map((tag) => (
                      <span
                        key={tag}
                        className="px-2 py-1 bg-gray-100 text-gray-600 text-sm rounded"
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
              </>
            );
          })()}

          {event.eventVendors.length > 0 && (
            <Card>
              <CardHeader>
                <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
                  <Store className="w-5 h-5" />
                  Participating Vendors
                </h2>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {event.eventVendors.map(({ vendor }) => (
                    <Link
                      key={vendor.id}
                      href={`/vendors/${vendor.slug}`}
                      className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center">
                        {vendor.logoUrl ? (
                          <img
                            src={vendor.logoUrl}
                            alt={vendor.businessName}
                            className="w-10 h-10 rounded-full object-cover"
                          />
                        ) : (
                          <Store className="w-5 h-5 text-gray-400" />
                        )}
                      </div>
                      <div>
                        <p className="font-medium text-gray-900">
                          {vendor.businessName}
                        </p>
                        {vendor.vendorType && (
                          <p className="text-sm text-gray-500">
                            {vendor.vendorType}
                          </p>
                        )}
                      </div>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </main>

        <aside className="space-y-6">
          <Card>
            <CardContent className="p-6 space-y-4">
              <div className="flex items-start gap-3">
                <Calendar className="w-5 h-5 text-blue-600 mt-0.5" />
                <div>
                  <p className="font-medium text-gray-900">
                    {formatDateRange(event.startDate, event.endDate)}
                  </p>
                  <p className="text-sm text-gray-500 flex items-center gap-1 mt-1">
                    <Clock className="w-4 h-4" />
                    {new Date(event.startDate).toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <MapPin className="w-5 h-5 text-blue-600 mt-0.5" />
                <div>
                  <Link
                    href={`/venues/${event.venue.slug}`}
                    className="font-medium text-gray-900 hover:text-blue-600"
                  >
                    {event.venue.name}
                  </Link>
                  <p className="text-sm text-gray-500">
                    {event.venue.address}
                    <br />
                    {event.venue.city}, {event.venue.state} {event.venue.zip}
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <Tag className="w-5 h-5 text-blue-600 mt-0.5" />
                <div>
                  <p className="font-medium text-gray-900">
                    {formatPrice(event.ticketPriceMin, event.ticketPriceMax)}
                  </p>
                </div>
              </div>

              {event.ticketUrl && (
                <a
                  href={event.ticketUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Button className="w-full" size="lg">
                    <ExternalLink className="w-4 h-4 mr-2" />
                    Get Tickets
                  </Button>
                </a>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <h3 className="font-semibold text-gray-900">Presented By</h3>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center">
                  {event.promoter.logoUrl ? (
                    <img
                      src={event.promoter.logoUrl}
                      alt={event.promoter.companyName}
                      className="w-12 h-12 rounded-full object-cover"
                    />
                  ) : (
                    <User className="w-6 h-6 text-gray-400" />
                  )}
                </div>
                <div>
                  <p className="font-medium text-gray-900">
                    {event.promoter.companyName}
                  </p>
                  {event.promoter.verified && (
                    <Badge variant="success">Verified</Badge>
                  )}
                </div>
              </div>
              {event.promoter.website && (
                <a
                  href={event.promoter.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 text-sm text-blue-600 hover:text-blue-700 flex items-center gap-1"
                >
                  Visit Website <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
