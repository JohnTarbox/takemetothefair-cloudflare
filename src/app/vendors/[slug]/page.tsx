import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { Store, Globe, CheckCircle, Calendar, MapPin, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatDateRange } from "@/lib/utils";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, users, eventVendors, events, venues } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { parseJsonArray } from "@/types";
import { auth } from "@/lib/auth";
import type { Metadata } from "next";
import { AddToCalendar } from "@/components/events/AddToCalendar";

export const runtime = "edge";
export const revalidate = 300; // Cache for 5 minutes


interface Props {
  params: Promise<{ slug: string }>;
}

async function getVendor(slug: string) {
  try {
    const db = getCloudflareDb();

    // Get vendor with user
    const vendorResults = await db
      .select()
      .from(vendors)
      .leftJoin(users, eq(vendors.userId, users.id))
      .where(eq(vendors.slug, slug))
      .limit(1);

    if (vendorResults.length === 0) return null;

    const vendor = vendorResults[0];

    // Get event vendors with events and venues
    const eventVendorResults = await db
      .select()
      .from(eventVendors)
      .leftJoin(events, eq(eventVendors.eventId, events.id))
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(
        and(
          eq(eventVendors.vendorId, vendor.vendors.id),
          eq(eventVendors.status, "APPROVED")
        )
      );

    const vendorEvents = eventVendorResults
      .filter((ev) => ev.events !== null)
      .map((ev) => ({
        ...ev.event_vendors,
        event: {
          ...ev.events!,
          venue: ev.venues!,
        },
      }))
      .sort((a, b) => new Date(a.event.startDate).getTime() - new Date(b.event.startDate).getTime());

    return {
      ...vendor.vendors,
      user: vendor.users ? { name: vendor.users.name, email: vendor.users.email } : { name: null, email: null },
      eventVendors: vendorEvents,
    };
  } catch (e) {
    console.error("Error fetching vendor:", e);
    return null;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const vendor = await getVendor(slug);

  if (!vendor) {
    return { title: "Vendor Not Found" };
  }

  const title = `${vendor.businessName} | Meet Me at the Fair`;
  const description = vendor.description?.slice(0, 160) || `${vendor.businessName} - ${vendor.vendorType}`;
  const url = `https://meetmeatthefair.com/vendors/${vendor.slug}`;

  return {
    title,
    description,
    alternates: {
      canonical: url,
    },
    openGraph: {
      title: vendor.businessName,
      description,
      url,
      siteName: "Meet Me at the Fair",
      type: "website",
      ...(vendor.logoUrl && {
        images: [
          {
            url: vendor.logoUrl,
            width: 400,
            height: 400,
            alt: vendor.businessName,
          },
        ],
      }),
    },
    twitter: {
      card: vendor.logoUrl ? "summary" : "summary",
      title: vendor.businessName,
      description,
      ...(vendor.logoUrl && { images: [vendor.logoUrl] }),
    },
  };
}

export default async function VendorDetailPage({ params }: Props) {
  const { slug } = await params;
  const vendor = await getVendor(slug);

  if (!vendor) {
    notFound();
  }

  const session = await auth();
  const isAdmin = session?.user?.role === "ADMIN";

  const upcomingEvents = vendor.eventVendors.filter(
    (ev) => new Date(ev.event.endDate) >= new Date()
  );
  const pastEvents = vendor.eventVendors.filter(
    (ev) => new Date(ev.event.endDate) < new Date()
  );

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <main className="lg:col-span-2 space-y-6">
          <div className="flex items-start gap-6">
            <div className="w-24 h-24 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0 relative overflow-hidden">
              {vendor.logoUrl ? (
                <Image
                  src={vendor.logoUrl}
                  alt={vendor.businessName}
                  fill
                  sizes="96px"
                  className="object-cover rounded-xl"
                />
              ) : (
                <Store className="w-12 h-12 text-gray-400" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-3xl font-bold text-gray-900">
                  {vendor.businessName}
                </h1>
                {vendor.verified && (
                  <CheckCircle className="w-6 h-6 text-blue-600" />
                )}
              </div>
              {vendor.vendorType && (
                <p className="mt-1 text-lg text-gray-600">{vendor.vendorType}</p>
              )}
            </div>
          </div>

          {vendor.description && (
            <div className="prose prose-gray max-w-none">
              <p className="text-gray-600 whitespace-pre-wrap">
                {vendor.description}
              </p>
            </div>
          )}

          {(() => {
            const products = parseJsonArray(vendor.products);
            return products.length > 0 && (
              <div>
                <h2 className="text-xl font-semibold text-gray-900 mb-3">
                  Products & Services
                </h2>
                <div className="flex flex-wrap gap-2">
                  {products.map((product) => (
                    <Badge key={product} variant="info">
                      {product}
                    </Badge>
                  ))}
                </div>
              </div>
            );
          })()}

          {upcomingEvents.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold text-gray-900">
                  Upcoming Events ({upcomingEvents.length})
                </h2>
                {vendor.eventVendors.length > 6 && (
                  <Link
                    href={`/vendors/${vendor.slug}/events`}
                    className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                  >
                    View all events
                  </Link>
                )}
              </div>
              <div className="space-y-3">
                {upcomingEvents.slice(0, 6).map(({ event }) => (
                  <Card key={event.id} className="hover:shadow-md transition-shadow">
                    <CardContent className="p-4 flex items-center gap-4">
                      <Link href={`/events/${event.slug}`} className="w-16 h-16 rounded-lg bg-blue-50 flex flex-col items-center justify-center text-blue-600">
                        <Calendar className="w-6 h-6" />
                      </Link>
                      <div className="flex-1">
                        <Link href={`/events/${event.slug}`}>
                          <h3 className="font-medium text-gray-900 hover:text-blue-600">
                            {event.name}
                          </h3>
                        </Link>
                        <div className="flex items-center gap-2 text-sm text-gray-600">
                          <span>{formatDateRange(event.startDate, event.endDate)}</span>
                          <AddToCalendar
                            title={event.name}
                            description={event.description || undefined}
                            location={`${event.venue.name}, ${event.venue.address || ""}, ${event.venue.city}, ${event.venue.state} ${event.venue.zip || ""}`}
                            startDate={event.startDate}
                            endDate={event.endDate}
                            url={`https://meetmeatthefair.com/events/${event.slug}`}
                            variant="icon"
                          />
                        </div>
                        <p className="text-sm text-gray-500 flex items-center gap-1 mt-1">
                          <MapPin className="w-3 h-3" />
                          {event.venue.name}, {event.venue.city}
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
              {upcomingEvents.length > 6 && (
                <div className="mt-4 text-center">
                  <Link
                    href={`/vendors/${vendor.slug}/events`}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors"
                  >
                    View all {vendor.eventVendors.length} events
                  </Link>
                </div>
              )}
            </div>
          )}

          {pastEvents.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold text-gray-900">
                  Past Events ({pastEvents.length})
                </h2>
                {pastEvents.length > 5 && (
                  <Link
                    href={`/vendors/${vendor.slug}/events?filter=past`}
                    className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                  >
                    View all past events
                  </Link>
                )}
              </div>
              <div className="space-y-3">
                {pastEvents.slice(0, 5).map(({ event }) => (
                  <Link key={event.id} href={`/events/${event.slug}`}>
                    <Card className="hover:shadow-md transition-shadow opacity-75">
                      <CardContent className="p-4 flex items-center gap-4">
                        <div className="w-16 h-16 rounded-lg bg-gray-100 flex flex-col items-center justify-center text-gray-400">
                          <Calendar className="w-6 h-6" />
                        </div>
                        <div className="flex-1">
                          <h3 className="font-medium text-gray-700">
                            {event.name}
                          </h3>
                          <p className="text-sm text-gray-500">
                            {formatDateRange(event.startDate, event.endDate)}
                          </p>
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
              {pastEvents.length > 5 && (
                <div className="mt-4 text-center">
                  <Link
                    href={`/vendors/${vendor.slug}/events`}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors"
                  >
                    View all {pastEvents.length} past events
                  </Link>
                </div>
              )}
            </div>
          )}
        </main>

        <aside className="space-y-6">
          {isAdmin && (
            <Card>
              <CardContent className="p-6">
                <Link href={`/admin/vendors/${vendor.id}/edit`}>
                  <Button variant="outline" className="w-full">
                    <Pencil className="w-4 h-4 mr-2" />
                    Edit Vendor
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <h3 className="font-semibold text-gray-900">Contact & Links</h3>
            </CardHeader>
            <CardContent className="space-y-3">
              {vendor.website && (
                <a
                  href={vendor.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 text-gray-700 hover:text-blue-600"
                >
                  <Globe className="w-5 h-5 text-blue-600" />
                  Visit Website
                </a>
              )}
              {vendor.socialLinks &&
                typeof vendor.socialLinks === "object" &&
                Object.entries(vendor.socialLinks as Record<string, string>).map(
                  ([platform, url]) => (
                    <a
                      key={platform}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-3 text-gray-700 hover:text-blue-600 capitalize"
                    >
                      {platform}
                    </a>
                  )
                )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="text-center">
                <p className="text-3xl font-bold text-gray-900">
                  {vendor.eventVendors.length}
                </p>
                <p className="text-sm text-gray-600">Total Events Attended</p>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
