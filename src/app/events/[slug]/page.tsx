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
  DollarSign,
  Home,
  Trees,
  Users,
  FileText,
  CheckCircle,
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
  blogPosts,
  contentLinks,
} from "@/lib/db/schema";
import { eq, and, sql, ne, gte, lt, like, desc, or } from "drizzle-orm";
import { isPublicVendorStatus, STATUS_BADGE_VARIANTS } from "@/lib/vendor-status";
import type { EventVendorStatus } from "@/lib/constants";
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
import { haversineDistance, formatDistance } from "@/lib/geo";
import { TrackedLink } from "@/components/TrackedLink";
import { OutboundEventLink } from "@/components/OutboundEventLink";
import { getPromoterResponseStats } from "@/lib/promoter-stats";
import { StickyApplyBar } from "@/components/events/StickyApplyBar";
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

// Check if this event's dates conflict with vendor's other active applications
async function getVendorDateConflicts(
  vendorId: string,
  eventId: string,
  startDate: Date | null,
  endDate: Date | null
): Promise<string[]> {
  if (!startDate || !endDate) return [];
  const db = getCloudflareDb();
  try {
    const apps = await db
      .select({
        eventId: eventVendors.eventId,
        status: eventVendors.status,
        eventName: events.name,
        eventStartDate: events.startDate,
        eventEndDate: events.endDate,
      })
      .from(eventVendors)
      .leftJoin(events, eq(eventVendors.eventId, events.id))
      .where(eq(eventVendors.vendorId, vendorId));

    const activeStatuses = new Set([
      "INVITED",
      "INTERESTED",
      "APPLIED",
      "WAITLISTED",
      "APPROVED",
      "CONFIRMED",
    ]);
    const conflicting: string[] = [];
    const eStart = startDate.getTime();
    const eEnd = endDate.getTime();

    for (const app of apps) {
      if (app.eventId === eventId) continue;
      if (!activeStatuses.has(app.status)) continue;
      if (!app.eventStartDate || !app.eventEndDate) continue;
      const oStart = new Date(app.eventStartDate).getTime();
      const oEnd = new Date(app.eventEndDate).getTime();
      if (eStart <= oEnd && eEnd >= oStart) {
        conflicting.push(app.eventName || "Unknown event");
      }
    }
    return conflicting;
  } catch {
    return [];
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

async function getRelatedEvents(
  eventId: string,
  venueId: string | null,
  categories: string[],
  isPastEvent: boolean
) {
  const db = getCloudflareDb();
  try {
    const dateCondition = isPastEvent
      ? lt(events.endDate, new Date())
      : gte(events.endDate, new Date());
    const baseConditions = [ne(events.id, eventId), isPublicEventStatus(), dateCondition];

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

type RelatedBlogPost = {
  title: string;
  slug: string;
  excerpt: string | null;
  publishDate: Date | null;
  /** "direct" = the post body contains a /events/<slug> link to this event.
   *  "category" = matched on shared tag/category only (topical fallback). */
  kind: "direct" | "category";
};

/**
 * Posts that explicitly link to this event via /events/{slug} in the body.
 * Joined through content_links, so this is O(direct-links) not O(posts).
 */
async function getDirectlyLinkedBlogPosts(
  eventId: string,
  limit: number
): Promise<RelatedBlogPost[]> {
  if (limit <= 0) return [];
  try {
    const db = getCloudflareDb();
    const rows = await db
      .select({
        title: blogPosts.title,
        slug: blogPosts.slug,
        excerpt: blogPosts.excerpt,
        publishDate: blogPosts.publishDate,
      })
      .from(contentLinks)
      .innerJoin(blogPosts, eq(contentLinks.sourceId, blogPosts.id))
      .where(
        and(
          eq(contentLinks.sourceType, "BLOG_POST"),
          eq(contentLinks.targetType, "EVENT"),
          eq(contentLinks.targetId, eventId),
          eq(blogPosts.status, "PUBLISHED")
        )
      )
      .orderBy(desc(blogPosts.publishDate))
      .limit(limit);
    return rows.map((r) => ({ ...r, kind: "direct" as const }));
  } catch {
    return [];
  }
}

/**
 * Category/tag-based matches. Used to fill remaining slots once the direct
 * links are in. Excludes slugs already surfaced as direct links so we don't
 * double-render the same post.
 */
async function getCategoryMatchedBlogPosts(
  eventName: string,
  categories: string[],
  excludeSlugs: string[],
  limit: number
): Promise<RelatedBlogPost[]> {
  if (limit <= 0) return [];
  try {
    const db = getCloudflareDb();
    const searchConditions = [
      like(blogPosts.tags, `%${eventName}%`),
      ...categories.map((cat) => like(blogPosts.tags, `%${cat}%`)),
      ...categories.map((cat) => like(blogPosts.categories, `%${cat}%`)),
    ];

    const posts = await db
      .select({
        title: blogPosts.title,
        slug: blogPosts.slug,
        excerpt: blogPosts.excerpt,
        publishDate: blogPosts.publishDate,
      })
      .from(blogPosts)
      .where(and(eq(blogPosts.status, "PUBLISHED"), or(...searchConditions)))
      .orderBy(desc(blogPosts.publishDate))
      .limit(limit + excludeSlugs.length);

    const excluded = new Set(excludeSlugs);
    return posts
      .filter((p) => !excluded.has(p.slug))
      .slice(0, limit)
      .map((p) => ({ ...p, kind: "category" as const }));
  } catch {
    return [];
  }
}

async function getRelatedBlogPosts(
  eventId: string,
  eventName: string,
  categories: string[]
): Promise<RelatedBlogPost[]> {
  const direct = await getDirectlyLinkedBlogPosts(eventId, 3);
  const remaining = 3 - direct.length;
  if (remaining <= 0) return direct;
  const category = await getCategoryMatchedBlogPosts(
    eventName,
    categories,
    direct.map((p) => p.slug),
    remaining
  );
  return [...direct, ...category];
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
  const dateConflicts = vendorInfo
    ? await getVendorDateConflicts(vendorInfo.vendor.id, event.id, event.startDate, event.endDate)
    : [];
  // Apply-modal trust signals (Phase 5): only fetched when the current user
  // is a vendor who hasn't already applied, to avoid an unnecessary query for
  // the public detail page.
  const promoterStats =
    vendorInfo && !vendorInfo.existingApplication && event.promoterId
      ? await getPromoterResponseStats(event.promoterId)
      : null;
  const confirmedVendorsCount = event.eventVendors.length;
  // Compute distance from vendor home base to venue
  const vendorDistance =
    vendorInfo?.vendor.latitude &&
    vendorInfo?.vendor.longitude &&
    event.venue?.latitude &&
    event.venue?.longitude
      ? haversineDistance(
          vendorInfo.vendor.latitude,
          vendorInfo.vendor.longitude,
          event.venue.latitude,
          event.venue.longitude
        )
      : null;
  const isAdmin = session?.user?.role === "ADMIN";
  const isVendor = !!vendorInfo;
  const isPastEvent = event.endDate ? new Date(event.endDate) < new Date() : false;
  const eventCategories = parseJsonArray(event.categories);
  const [relatedEvents, relatedBlogPosts] = await Promise.all([
    getRelatedEvents(event.id, event.venueId, eventCategories, isPastEvent),
    getRelatedBlogPosts(event.id, event.name, eventCategories),
  ]);

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
        stateCode={event.stateCode}
        organizer={
          event.promoter && event.promoter.slug !== "meet-me-at-the-fair"
            ? {
                name: event.promoter.companyName,
                url: event.promoter.website,
              }
            : {
                name: "Meet Me at the Fair",
                url: "https://meetmeatthefair.com",
              }
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
                        ? formatDiscontinuousDates(
                            isAdmin || isVendor
                              ? event.eventDays
                              : event.eventDays.filter((d: any) => !d.vendorOnly)
                          )
                        : formatDateRange(
                            isAdmin || isVendor
                              ? event.startDate
                              : (event.publicStartDate ?? event.startDate),
                            isAdmin || isVendor
                              ? event.endDate
                              : (event.publicEndDate ?? event.endDate)
                          )}
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
                      eventDays={event.eventDays}
                    />
                  </div>
                  {event.eventDays && event.eventDays.length > 0 ? (
                    <DailyScheduleDisplay
                      days={event.eventDays}
                      discontinuousDates={event.discontinuousDates ?? false}
                      className="mt-2"
                      showVendorDays={isAdmin ? "all" : isVendor ? "badge" : "hide"}
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
                      className="font-medium text-gray-900 hover:text-navy"
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
                    {vendorDistance != null && (
                      <p className="text-sm text-purple-600 font-medium mt-1">
                        {formatDistance(vendorDistance)} from your home base
                      </p>
                    )}
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

              {/* Vendor Decision Fields */}
              {(event.vendorFeeMin != null || event.vendorFeeMax != null) && (
                <div className="flex items-start gap-3">
                  <DollarSign className="w-5 h-5 text-green-600 mt-0.5" />
                  <div>
                    <p className="text-sm text-gray-500">Vendor/Booth Fee</p>
                    <p className="font-medium text-gray-900">
                      {formatPrice(event.vendorFeeMin, event.vendorFeeMax)}
                    </p>
                    {event.vendorFeeNotes && (
                      <p className="text-xs text-gray-500 mt-0.5">{event.vendorFeeNotes}</p>
                    )}
                  </div>
                </div>
              )}

              {event.indoorOutdoor && (
                <div className="flex items-start gap-3">
                  {event.indoorOutdoor === "INDOOR" ? (
                    <Home className="w-5 h-5 text-blue-500 mt-0.5" />
                  ) : (
                    <Trees className="w-5 h-5 text-green-500 mt-0.5" />
                  )}
                  <div>
                    <p className="font-medium text-gray-900">
                      {event.indoorOutdoor === "INDOOR"
                        ? "Indoor"
                        : event.indoorOutdoor === "OUTDOOR"
                          ? "Outdoor"
                          : "Indoor & Outdoor"}
                    </p>
                  </div>
                </div>
              )}

              {(event.estimatedAttendance || event.eventScale) && (
                <div className="flex items-start gap-3">
                  <Users className="w-5 h-5 text-purple-500 mt-0.5" />
                  <div>
                    {event.estimatedAttendance && (
                      <p className="font-medium text-gray-900">
                        ~{event.estimatedAttendance.toLocaleString()} attendees
                      </p>
                    )}
                    {event.eventScale && (
                      <p className="text-sm text-gray-500">
                        {event.eventScale === "SMALL"
                          ? "Small community event"
                          : event.eventScale === "MEDIUM"
                            ? "Regional event"
                            : event.eventScale === "LARGE"
                              ? "Large state-level event"
                              : "Major multi-state event"}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {event.walkInsAllowed && (
                <div className="flex items-start gap-3">
                  <CheckCircle className="w-5 h-5 text-green-500 mt-0.5" />
                  <div>
                    <p className="font-medium text-gray-900">Walk-in Vendors Welcome</p>
                  </div>
                </div>
              )}

              {(event.applicationDeadline ||
                event.applicationUrl ||
                event.applicationInstructions) && (
                <div className="flex items-start gap-3">
                  <FileText className="w-5 h-5 text-amber-500 mt-0.5" />
                  <div>
                    <p className="text-sm text-gray-500">Vendor Applications</p>
                    {event.applicationDeadline && (
                      <p
                        className={`text-sm font-medium ${new Date(event.applicationDeadline) < new Date() ? "text-red-600" : "text-gray-900"}`}
                      >
                        Deadline: {new Date(event.applicationDeadline).toLocaleDateString()}
                        {new Date(event.applicationDeadline) < new Date() && " (Passed)"}
                      </p>
                    )}
                    {event.applicationInstructions && (
                      <p className="text-xs text-gray-500 mt-0.5">
                        {event.applicationInstructions}
                      </p>
                    )}
                    {event.applicationUrl && (
                      <OutboundEventLink
                        kind="application"
                        eventSlug={event.slug}
                        href={event.applicationUrl}
                        className="text-sm text-blue-600 hover:underline mt-1 inline-block"
                      >
                        Apply Now →
                      </OutboundEventLink>
                    )}
                  </div>
                </div>
              )}

              {event.ticketUrl && (
                <OutboundEventLink kind="ticket" eventSlug={event.slug} href={event.ticketUrl}>
                  <Button className="w-full" size="lg">
                    <ExternalLink className="w-4 h-4 mr-2" />
                    Event Website
                  </Button>
                </OutboundEventLink>
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
            <Card id="vendor-apply">
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
                        STATUS_BADGE_VARIANTS[
                          vendorInfo.existingApplication.status as EventVendorStatus
                        ] ?? "warning"
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
                  <>
                    {dateConflicts.length > 0 && (
                      <div className="flex items-start gap-2 text-sm text-amber-700 bg-amber-50 rounded-md px-3 py-2 mb-3">
                        <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                        <span>Date conflict with: {dateConflicts.join(", ")}</span>
                      </div>
                    )}
                    <VendorApplyButton
                      eventId={event.id}
                      eventName={event.name}
                      canSelfConfirm={vendorInfo.vendor.canSelfConfirm ?? false}
                      applicationDeadline={
                        event.applicationDeadline
                          ? new Date(event.applicationDeadline).toISOString()
                          : null
                      }
                      confirmedVendorsCount={confirmedVendorsCount}
                      promoterMedianResponseDays={promoterStats?.medianDays ?? null}
                    />
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {!session && (
            <Card id="vendor-apply">
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
          {isPastEvent && (
            <div className="mt-6 text-center">
              <Link href="/events" className="text-royal hover:text-navy text-sm font-medium">
                Browse upcoming events &rarr;
              </Link>
            </div>
          )}
        </div>
      )}

      {/* Related Blog Posts — direct-link posts are labeled; category
          matches are unlabeled fallback filler when there aren't 3 direct
          links. See Phase: content-entity link index. */}
      {relatedBlogPosts.length > 0 && (
        <div className="mt-12 border-t border-gray-200 pt-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-6">Related Blog Posts</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {relatedBlogPosts.map((post) => (
              <Link
                key={post.slug}
                href={`/blog/${post.slug}`}
                className="p-4 bg-white rounded-lg border border-gray-200 hover:border-amber hover:shadow-sm transition-all group"
              >
                {post.kind === "direct" && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 mb-2 rounded-full text-[11px] font-medium bg-amber-light text-amber-dark">
                    Written about this event
                  </span>
                )}
                <p className="font-medium text-gray-900 group-hover:text-navy line-clamp-2">
                  {post.title}
                </p>
                {post.excerpt && (
                  <p className="text-sm text-gray-500 mt-2 line-clamp-2">{post.excerpt}</p>
                )}
                {post.publishDate && (
                  <p className="text-xs text-gray-400 mt-2">
                    {new Date(post.publishDate).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      timeZone: "UTC",
                    })}
                  </p>
                )}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Mobile-only sticky apply CTA */}
      {!isPastEvent && !session && <StickyApplyBar label="Login to Apply" href="/login" />}
      {!isPastEvent && vendorInfo && !vendorInfo.existingApplication && (
        <StickyApplyBar label="Apply as Vendor" scrollTarget="vendor-apply" />
      )}
    </div>
  );
}
