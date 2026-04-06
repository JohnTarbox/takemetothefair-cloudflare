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
  UserPlus,
  Eye,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatDateRange, formatDiscontinuousDates, formatPrice } from "@/lib/utils";
import { getCloudflareDb } from "@/lib/cloudflare";
import {
  events,
  venues,
  promoters,
  eventVendors,
  vendors,
  users,
  eventDays,
} from "@/lib/db/schema";
import { eq, and, sql, ne, gte, like } from "drizzle-orm";
import { isPublicVendorStatus } from "@/lib/vendor-status";
import { isPublicEventStatus } from "@/lib/event-status";
import { DailyScheduleDisplay } from "@/components/events/DailyScheduleDisplay";
import { parseJsonArray } from "@/types";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { VendorApplyButton } from "@/components/events/VendorApplyButton";
import { AddToCalendar } from "@/components/events/AddToCalendar";
import { EventSchema } from "@/components/seo/EventSchema";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { ShareButtons } from "@/components/ShareButtons";
import { getCategoryBadgeClass } from "@/lib/category-colors";
import { buildEventMetaDescription } from "@/lib/seo-utils";
import { TrackedLink } from "@/components/TrackedLink";
import { FavoriteButton } from "@/components/FavoriteButton";
import { EventCard } from "@/components/events/event-card";
import { DetailPageTracker } from "@/components/DetailPageTracker";
import { ScrollDepthTracker } from "@/components/ScrollDepthTracker";

export const runtime = "edge";
export const revalidate = 300; // Cache for 5 minutes

interface Props {
  params: Promise<{ slug: string }>;
}

async function getUserVendorInfo(userId: string | undefined, eventId: string) {
  if (!userId) return null;

  const db = getCloudflareDb();

  try {
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
      .where(and(eq(eventVendors.eventId, eventId), eq(eventVendors.vendorId, vendor.id)))
      .limit(1);

    return {
      vendor,
      existingApplication: existingApplication.length > 0 ? existingApplication[0] : null,
    };
  } catch (e) {
    await logError(db, {
      message: "Error fetching vendor info",
      error: e,
      source: "app/events/[slug]/page.tsx:getUserVendorInfo",
      context: { userId, eventId },
    });
    return null;
  }
}

async function getEvent(slug: string) {
  const db = getCloudflareDb();

  try {
    // Get event with venue and promoter
    const eventResults = await db
      .select()
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(and(eq(events.slug, slug), isPublicEventStatus()))
      .limit(1);

    if (eventResults.length === 0) return null;

    const eventData = eventResults[0];

    // Get promoter's user
    const promoterUser = eventData.promoters?.userId
      ? await db
          .select({ name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, eventData.promoters.userId))
          .limit(1)
      : [];

    // Get event vendors
    const eventVendorResults = await db
      .select()
      .from(eventVendors)
      .leftJoin(vendors, eq(eventVendors.vendorId, vendors.id))
      .where(and(eq(eventVendors.eventId, eventData.events.id), isPublicVendorStatus()));

    // Get event days (per-day schedule)
    const eventDayResults = await db
      .select()
      .from(eventDays)
      .where(eq(eventDays.eventId, eventData.events.id))
      .orderBy(eventDays.date);

    // Increment view count
    await db
      .update(events)
      .set({ viewCount: sql`${events.viewCount} + 1` })
      .where(eq(events.id, eventData.events.id));

    return {
      ...eventData.events,
      venue: eventData.venues,
      promoter: eventData.promoters
        ? {
            ...eventData.promoters,
            user: promoterUser[0] || { name: null, email: null },
          }
        : null,
      eventVendors: eventVendorResults.map((ev) => ({
        ...ev.event_vendors,
        vendor: ev.vendors!,
      })),
      eventDays: eventDayResults,
    };
  } catch (e) {
    await logError(db, {
      message: "Error fetching event",
      error: e,
      source: "app/events/[slug]/page.tsx:getEvent",
      context: { slug },
    });
    return null;
  }
}

async function getRelatedEvents(eventId: string, venueId: string | null, categories: string[]) {
  const db = getCloudflareDb();
  try {
    const baseConditions = [
      ne(events.id, eventId),
      isPublicEventStatus(),
      gte(events.endDate, new Date()),
    ];

    // Try same venue first
    if (venueId) {
      const sameVenue = await db
        .select()
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .leftJoin(promoters, eq(events.promoterId, promoters.id))
        .where(and(...baseConditions, eq(events.venueId, venueId)))
        .orderBy(events.startDate)
        .limit(4);

      if (sameVenue.length >= 2) {
        return {
          heading: "More Events at This Venue",
          events: sameVenue.map((r) => ({ ...r.events, venue: r.venues, promoter: r.promoters })),
        };
      }
    }

    // Fallback: same category
    const primaryCategory = categories[0];
    if (primaryCategory) {
      const sameCategory = await db
        .select()
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .leftJoin(promoters, eq(events.promoterId, promoters.id))
        .where(and(...baseConditions, like(events.categories, `%${primaryCategory}%`)))
        .orderBy(events.startDate)
        .limit(4);

      if (sameCategory.length > 0) {
        return {
          heading: `More ${primaryCategory} Events`,
          events: sameCategory.map((r) => ({
            ...r.events,
            venue: r.venues,
            promoter: r.promoters,
          })),
        };
      }
    }

    return null;
  } catch {
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
  const description = buildEventMetaDescription(event);
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
      type: "article",
      images: [
        {
          url: event.imageUrl || `https://meetmeatthefair.com/api/og?slug=${event.slug}`,
          width: 1200,
          height: 630,
          alt: event.name,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: event.name,
      description,
      images: [event.imageUrl || `https://meetmeatthefair.com/api/og?slug=${event.slug}`],
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
  const relatedEvents = await getRelatedEvents(
    event.id,
    event.venueId,
    parseJsonArray(event.categories)
  );

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <DetailPageTracker type="event" slug={event.slug} name={event.name} />
      <ScrollDepthTracker pageType="event-detail" />
      <EventSchema
        name={event.name}
        slug={event.slug}
        description={event.description || undefined}
        startDate={event.startDate}
        endDate={event.endDate}
        imageUrl={event.imageUrl}
        url={`https://meetmeatthefair.com/events/${event.slug}`}
        venue={
          event.venue
            ? {
                name: event.venue.name,
                address: event.venue.address,
                city: event.venue.city,
                state: event.venue.state,
                zip: event.venue.zip,
                latitude: event.venue.latitude,
                longitude: event.venue.longitude,
              }
            : null
        }
        organizer={
          event.promoter && event.promoter.slug !== "meet-me-at-the-fair"
            ? {
                name: event.promoter.companyName,
                url: event.promoter.website,
              }
            : null
        }
        ticketPriceMin={event.ticketPriceMin}
        ticketPriceMax={event.ticketPriceMax}
        ticketUrl={event.ticketUrl}
        categories={parseJsonArray(event.categories)}
        datesConfirmed={event.datesConfirmed}
        eventDays={event.eventDays}
        vendors={event.eventVendors.slice(0, 10).map(({ vendor }) => ({
          name: vendor.businessName,
          url: `https://meetmeatthefair.com/vendors/${vendor.slug}`,
        }))}
        createdAt={event.createdAt}
      />
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Events", url: "https://meetmeatthefair.com/events" },
          { name: event.name, url: `https://meetmeatthefair.com/events/${event.slug}` },
        ]}
      />
      {event.status === "TENTATIVE" && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm text-amber-800">
            <strong>Tentative Event</strong> — This event has not yet been verified by our team.
            Details may be incomplete or inaccurate.
          </p>
        </div>
      )}
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
            const INTERNAL_TAGS = new Set([
              "imported",
              "url-import",
              "community-suggestion",
              "vendor-submission",
            ]);
            const publicTags = tags.filter((tag) => !INTERNAL_TAGS.has(tag) && !tag.includes("."));
            return (
              <>
                <div>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {event.featured && <Badge variant="warning">Featured</Badge>}
                    {event.status === "TENTATIVE" && (
                      <Badge variant="info">Tentative — Unverified</Badge>
                    )}
                    {categories.map((cat) => (
                      <Badge key={cat} className={getCategoryBadgeClass(cat)}>
                        {cat}
                      </Badge>
                    ))}
                  </div>
                  <div className="flex items-start justify-between gap-4">
                    <h1 className="text-3xl md:text-4xl font-bold text-gray-900">{event.name}</h1>
                    <div className="flex items-center gap-2">
                      <FavoriteButton type="EVENT" id={event.id} size="lg" />
                      <ShareButtons
                        url={`https://meetmeatthefair.com/events/${event.slug}`}
                        title={event.name}
                        description={event.description || undefined}
                      />
                    </div>
                  </div>
                  {(event.viewCount ?? 0) > 10 && (
                    <p className="text-sm text-gray-400 flex items-center gap-1 mt-1">
                      <Eye className="w-3.5 h-3.5" />
                      {(event.viewCount ?? 0).toLocaleString()} views
                    </p>
                  )}
                </div>

                <div className="prose prose-gray max-w-none">
                  <p className="text-gray-600 whitespace-pre-wrap">
                    {event.description || "No description available."}
                  </p>
                </div>

                {publicTags.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {publicTags.map((tag) => (
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
                      className="text-sm text-royal hover:text-navy font-medium"
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
                        <p className="font-medium text-gray-900">{vendor.businessName}</p>
                        {vendor.vendorType && (
                          <p className="text-sm text-gray-500">{vendor.vendorType}</p>
                        )}
                      </div>
                    </Link>
                  ))}
                </div>
                {event.eventVendors.length > 8 && (
                  <div className="mt-4 text-center">
                    <Link
                      href={`/events/${event.slug}/vendors`}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-royal hover:text-navy hover:bg-brand-blue-light rounded-lg transition-colors"
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
                <Calendar className="w-5 h-5 text-royal mt-0.5" />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-gray-900">
                      {event.discontinuousDates && event.eventDays?.length
                        ? formatDiscontinuousDates(event.eventDays)
                        : formatDateRange(event.startDate, event.endDate)}
                    </p>
                    <AddToCalendar
                      title={event.name}
                      description={event.description || undefined}
                      location={
                        event.venue
                          ? `${event.venue.name}, ${event.venue.address}, ${event.venue.city}, ${event.venue.state} ${event.venue.zip}`
                          : undefined
                      }
                      startDate={event.startDate}
                      endDate={event.endDate}
                      url={`https://meetmeatthefair.com/events/${event.slug}`}
                      variant="icon"
                      eventDays={event.eventDays as any}
                    />
                  </div>
                  {event.eventDays && event.eventDays.length > 0 ? (
                    <DailyScheduleDisplay
                      days={event.eventDays}
                      discontinuousDates={event.discontinuousDates ?? false}
                      className="mt-2"
                    />
                  ) : event.startDate ? (
                    <p className="text-sm text-gray-500 flex items-center gap-1 mt-1">
                      <Clock className="w-4 h-4" />
                      {new Date(event.startDate).toLocaleTimeString("en-US", {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </p>
                  ) : null}
                </div>
              </div>

              {event.venue ? (
                <div className="flex items-start gap-3">
                  <MapPin className="w-5 h-5 text-royal mt-0.5" />
                  <div>
                    <Link
                      href={`/venues/${event.venue.slug}`}
                      className="font-medium text-gray-900 hover:text-royal"
                    >
                      {event.venue.name}
                    </Link>
                    <p className="text-sm text-gray-500">
                      {event.venue.address}
                      <br />
                      {event.venue.city}, {event.venue.state} {event.venue.zip}
                    </p>
                    <a
                      href={
                        event.venue.googleMapsUrl ||
                        `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${event.venue.address}, ${event.venue.city}, ${event.venue.state} ${event.venue.zip}`)}`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-royal hover:text-navy mt-1"
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
                <Tag className="w-5 h-5 text-royal mt-0.5" />
                <div>
                  <p className="font-medium text-gray-900">
                    {formatPrice(event.ticketPriceMin, event.ticketPriceMax)}
                  </p>
                </div>
              </div>

              {event.ticketUrl && (
                <TrackedLink
                  href={event.ticketUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  eventLabel={event.ticketUrl}
                >
                  <Button className="w-full" size="lg">
                    <ExternalLink className="w-4 h-4 mr-2" />
                    Event Website
                  </Button>
                </TrackedLink>
              )}

              {isAdmin && (
                <div className="space-y-2 mt-3 pt-3 border-t">
                  <Link href={`/admin/events/${event.id}/vendors`}>
                    <Button className="w-full">
                      <UserPlus className="w-4 h-4 mr-2" />
                      Manage Vendors
                    </Button>
                  </Link>
                  <Link href={`/admin/events/${event.id}/edit`}>
                    <Button variant="outline" className="w-full">
                      <Pencil className="w-4 h-4 mr-2" />
                      Edit Event
                    </Button>
                  </Link>
                </div>
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
                    <Badge
                      variant={
                        vendorInfo.existingApplication.status === "CONFIRMED" ||
                        vendorInfo.existingApplication.status === "APPROVED"
                          ? "success"
                          : vendorInfo.existingApplication.status === "REJECTED" ||
                              vendorInfo.existingApplication.status === "CANCELLED"
                            ? "danger"
                            : "warning"
                      }
                    >
                      Application {vendorInfo.existingApplication.status}
                    </Badge>
                    <p className="text-sm text-gray-500 mt-2">
                      {vendorInfo.existingApplication.status === "APPLIED" &&
                        "Your application is being reviewed."}
                      {vendorInfo.existingApplication.status === "WAITLISTED" &&
                        "You're on the waitlist."}
                      {vendorInfo.existingApplication.status === "APPROVED" &&
                        "You've been approved!"}
                      {vendorInfo.existingApplication.status === "CONFIRMED" &&
                        "You're confirmed to participate!"}
                      {vendorInfo.existingApplication.status === "REJECTED" &&
                        "Your application was not accepted."}
                      {vendorInfo.existingApplication.status === "WITHDRAWN" &&
                        "You withdrew your application."}
                      {vendorInfo.existingApplication.status === "CANCELLED" &&
                        "Your participation was cancelled."}
                      {vendorInfo.existingApplication.status === "INTERESTED" &&
                        "You've expressed interest."}
                      {vendorInfo.existingApplication.status === "INVITED" &&
                        "You've been invited to participate!"}
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
                  <VendorApplyButton
                    eventId={event.id}
                    eventName={event.name}
                    canSelfConfirm={vendorInfo.vendor.canSelfConfirm ?? false}
                  />
                )}
              </CardContent>
            </Card>
          )}

          {!session && (
            <Card>
              <CardContent className="p-6 text-center">
                <Store className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                <p className="text-sm text-gray-600 mb-3">Are you a vendor?</p>
                <Link href="/login">
                  <Button variant="outline" className="w-full">
                    Login to Apply
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}

          {event.promoter && (
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
                    <p className="font-medium text-gray-900">{event.promoter.companyName}</p>
                    {event.promoter.verified && <Badge variant="success">Verified</Badge>}
                  </div>
                </div>
                {event.promoter.website && (
                  <TrackedLink
                    href={event.promoter.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-4 text-sm text-royal hover:text-navy flex items-center gap-1"
                    eventLabel={event.promoter.website}
                  >
                    Visit Website <ExternalLink className="w-3 h-3" />
                  </TrackedLink>
                )}
              </CardContent>
            </Card>
          )}
        </aside>
      </div>

      {/* Related Events */}
      {relatedEvents && relatedEvents.events.length > 0 && (
        <div className="mt-12 border-t border-gray-200 pt-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-6">{relatedEvents.heading}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {relatedEvents.events.map((relEvent) => (
              <EventCard key={relEvent.id} event={relEvent} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
