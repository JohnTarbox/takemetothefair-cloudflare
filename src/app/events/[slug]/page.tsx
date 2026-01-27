import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import {
  Calendar,
  MapPin,
  Tag,
  ExternalLink,
  Clock,
  User,
  Store,
  AlertCircle,
  Pencil,
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
import { auth } from "@/lib/auth";
import { VendorApplyButton } from "@/components/events/VendorApplyButton";
import { AddToCalendar } from "@/components/events/AddToCalendar";
import { EventSchema } from "@/components/seo/EventSchema";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { ShareButtons } from "@/components/ShareButtons";
import { FavoriteButton } from "@/components/FavoriteButton";

export const runtime = "edge";
export const revalidate = 300; // Cache for 5 minutes


interface Props {
  params: Promise<{ slug: string }>;
}

async function getUserVendorInfo(userId: string | undefined, eventId: string) {
  if (!userId) return null;

  try {
    const db = getCloudflareDb();

    // Get the vendor for this user
    const vendorResults = await db
      .select()
      .from(vendors)
      .where(eq(vendors.userId, userId))
      .limit(1);

    if (vendorResults.length === 0) return null;

    const vendor = vendorResults[0];

    // Check if vendor has already applied to this event
    const existingApplication = await db
      .select()
      .from(eventVendors)
      .where(and(
        eq(eventVendors.eventId, eventId),
        eq(eventVendors.vendorId, vendor.id)
      ))
      .limit(1);

    return {
      vendor,
      existingApplication: existingApplication.length > 0 ? existingApplication[0] : null,
    };
  } catch (e) {
    console.error("Error fetching vendor info:", e);
    return null;
  }
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
    const promoterUser = eventData.promoters ? await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, eventData.promoters.userId))
      .limit(1) : [];

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
      venue: eventData.venues,
      promoter: eventData.promoters ? {
        ...eventData.promoters,
        user: promoterUser[0] || { name: null, email: null },
      } : null,
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

  const title = `${event.name} | Meet Me at the Fair`;
  const description = event.description?.slice(0, 160) || `${event.name}${event.venue ? ` at ${event.venue.name}` : ""}`;
  const url = `https://meetmeatthefair.com/events/${event.slug}`;

  return {
    title,
    description,
    alternates: {
      canonical: url,
    },
    openGraph: {
      title: event.name,
      description,
      url,
      siteName: "Meet Me at the Fair",
      type: "website",
      ...(event.imageUrl && {
        images: [
          {
            url: event.imageUrl,
            width: 1200,
            height: 630,
            alt: event.name,
          },
        ],
      }),
    },
    twitter: {
      card: event.imageUrl ? "summary_large_image" : "summary",
      title: event.name,
      description,
      ...(event.imageUrl && { images: [event.imageUrl] }),
    },
  };
}

export default async function EventDetailPage({ params }: Props) {
  const { slug } = await params;
  const event = await getEvent(slug);

  if (!event) {
    notFound();
  }

  const session = await auth();
  const vendorInfo = await getUserVendorInfo(session?.user?.id, event.id);
  const isAdmin = session?.user?.role === "ADMIN";

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <EventSchema
        name={event.name}
        description={event.description || undefined}
        startDate={event.startDate}
        endDate={event.endDate}
        imageUrl={event.imageUrl}
        url={`https://meetmeatthefair.com/events/${event.slug}`}
        venue={event.venue ? {
          name: event.venue.name,
          address: event.venue.address,
          city: event.venue.city,
          state: event.venue.state,
          zip: event.venue.zip,
        } : null}
        organizer={event.promoter ? {
          name: event.promoter.companyName,
          url: event.promoter.website,
        } : null}
        ticketPriceMin={event.ticketPriceMin}
        ticketPriceMax={event.ticketPriceMax}
        ticketUrl={event.ticketUrl}
      />
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Events", url: "https://meetmeatthefair.com/events" },
          { name: event.name, url: `https://meetmeatthefair.com/events/${event.slug}` },
        ]}
      />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <main className="lg:col-span-2 space-y-6">
          {event.imageUrl && (
            <div className="aspect-video rounded-xl overflow-hidden bg-gray-100 relative">
              <Image
                src={event.imageUrl}
                alt={event.name}
                fill
                priority
                sizes="(max-width: 1024px) 100vw, 66vw"
                className="object-cover"
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
                  <div className="flex items-start justify-between gap-4">
                    <h1 className="text-3xl md:text-4xl font-bold text-gray-900">
                      {event.name}
                    </h1>
                    <div className="flex items-center gap-2">
                      <FavoriteButton type="EVENT" id={event.id} size="lg" />
                      <ShareButtons
                        url={`https://meetmeatthefair.com/events/${event.slug}`}
                        title={event.name}
                        description={event.description || undefined}
                      />
                    </div>
                  </div>
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
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
                    <Store className="w-5 h-5" />
                    Participating Vendors ({event.eventVendors.length})
                  </h2>
                  {event.eventVendors.length > 8 && (
                    <Link
                      href={`/events/${event.slug}/vendors`}
                      className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                    >
                      View all vendors
                    </Link>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {event.eventVendors.slice(0, 8).map(({ vendor }) => (
                    <Link
                      key={vendor.id}
                      href={`/vendors/${vendor.slug}`}
                      className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center relative overflow-hidden">
                        {vendor.logoUrl ? (
                          <Image
                            src={vendor.logoUrl}
                            alt={vendor.businessName}
                            fill
                            sizes="40px"
                            className="object-cover"
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
                {event.eventVendors.length > 8 && (
                  <div className="mt-4 text-center">
                    <Link
                      href={`/events/${event.slug}/vendors`}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors"
                    >
                      View all {event.eventVendors.length} vendors
                    </Link>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </main>

        <aside className="space-y-6">
          <Card>
            <CardContent className="p-6 space-y-4">
              <div className="flex items-start gap-3">
                <Calendar className="w-5 h-5 text-blue-600 mt-0.5" />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-gray-900">
                      {formatDateRange(event.startDate, event.endDate)}
                    </p>
                    <AddToCalendar
                      title={event.name}
                      description={event.description || undefined}
                      location={event.venue ? `${event.venue.name}, ${event.venue.address}, ${event.venue.city}, ${event.venue.state} ${event.venue.zip}` : undefined}
                      startDate={event.startDate}
                      endDate={event.endDate}
                      url={`https://meetmeatthefair.com/events/${event.slug}`}
                      variant="icon"
                    />
                  </div>
                  <p className="text-sm text-gray-500 flex items-center gap-1 mt-1">
                    <Clock className="w-4 h-4" />
                    {new Date(event.startDate).toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              </div>

              {event.venue ? (
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
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${event.venue.address}, ${event.venue.city}, ${event.venue.state} ${event.venue.zip}`)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 mt-1"
                    >
                      <ExternalLink className="w-3 h-3" />
                      View on Google Maps
                    </a>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3">
                  <MapPin className="w-5 h-5 text-gray-400 mt-0.5" />
                  <div>
                    <p className="text-sm text-gray-500">Venue to be announced</p>
                  </div>
                </div>
              )}

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
                    Event Website
                  </Button>
                </a>
              )}

              {isAdmin && (
                <Link href={`/admin/events/${event.id}/edit`}>
                  <Button variant="outline" className="w-full mt-3">
                    <Pencil className="w-4 h-4 mr-2" />
                    Edit Event
                  </Button>
                </Link>
              )}
            </CardContent>
          </Card>

          {/* Vendor Application Section */}
          {vendorInfo && (
            <Card>
              <CardHeader>
                <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                  <Store className="w-5 h-5" />
                  Vendor Participation
                </h3>
              </CardHeader>
              <CardContent>
                {vendorInfo.existingApplication ? (
                  <div className="text-center">
                    <Badge variant={
                      vendorInfo.existingApplication.status === "APPROVED" ? "success" :
                      vendorInfo.existingApplication.status === "REJECTED" ? "danger" :
                      "warning"
                    }>
                      Application {vendorInfo.existingApplication.status}
                    </Badge>
                    <p className="text-sm text-gray-500 mt-2">
                      {vendorInfo.existingApplication.status === "PENDING" && "Your application is being reviewed."}
                      {vendorInfo.existingApplication.status === "APPROVED" && "You're confirmed to participate!"}
                      {vendorInfo.existingApplication.status === "REJECTED" && "Your application was not accepted."}
                    </p>
                  </div>
                ) : vendorInfo.vendor.commercial && !event.commercialVendorsAllowed ? (
                  <div className="text-center">
                    <AlertCircle className="w-8 h-8 text-amber-500 mx-auto mb-2" />
                    <p className="text-sm text-gray-600">
                      This event does not allow commercial vendors.
                    </p>
                  </div>
                ) : (
                  <VendorApplyButton eventId={event.id} eventName={event.name} />
                )}
              </CardContent>
            </Card>
          )}

          {!session && (
            <Card>
              <CardContent className="p-6 text-center">
                <Store className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                <p className="text-sm text-gray-600 mb-3">
                  Are you a vendor?
                </p>
                <Link href="/login">
                  <Button variant="outline" className="w-full">
                    Login to Apply
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <h3 className="font-semibold text-gray-900">Presented By</h3>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center relative overflow-hidden">
                  {event.promoter.logoUrl ? (
                    <Image
                      src={event.promoter.logoUrl}
                      alt={event.promoter.companyName}
                      fill
                      sizes="48px"
                      className="object-cover"
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
