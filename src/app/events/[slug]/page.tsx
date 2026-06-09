import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import {
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
import { formatDateRange, formatDiscontinuousDates, formatPrice, unsafeSlug } from "@/lib/utils";
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
import { eq, and, sql, ne, lt, like, desc, or, isNull } from "drizzle-orm";
import { isPublicVendorStatus, STATUS_BADGE_VARIANTS } from "@/lib/vendor-status";
import type { EventVendorStatus } from "@/lib/constants";
import { isPublicEventStatus } from "@/lib/event-status";
import { upcomingEndPredicate } from "@/lib/event-dates";
import { eventJoinProjection } from "@/lib/db/event-join-projection";
import { DailyScheduleDisplay } from "@/components/events/DailyScheduleDisplay";
import { EventDayImageStrip } from "@/components/events/EventDayImageStrip";
import { parseJsonArray } from "@/types";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { VendorApplyButton } from "@/components/events/VendorApplyButton";
import { AddToCalendar } from "@/components/events/AddToCalendar";
import { EventSchema } from "@/components/seo/EventSchema";
import { groupVendorsByDay } from "@/lib/k18-vendor-grouping";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { FAQPageSchema } from "@/components/seo/FAQPageSchema";
import { EventFAQSection } from "@/components/events/EventFAQSection";
import { SameDayEventsButton } from "@/components/events/SameDayEventsButton";
import { buildEventFaqItems } from "@/lib/event-faq";
import { isFaqPilotEvent } from "@/lib/faq-pilot";
import { ShareButtons } from "@/components/ShareButtons";
import { PrintButton } from "@/components/print/PrintButton";
// PRINT1 (Dev-Email-2026-06-08 §B): the v1 standalone <PrintEventMap> +
// <PrintEventSheetFooter> are now composed inside <PrintEventSheet>, which
// is the opt-IN print-only template. The standalone v1 components stay
// exported for any future surface (vendor schedule, favorites) that needs
// just the QR/footer or just the map.
import { PrintEventSheet } from "@/components/print/PrintEventSheet";
import { getCategoryBadgeClass, getCategoryColors } from "@/lib/category-colors";
import { formatAudienceBadge } from "@/lib/event-audience";
import { buildEventMetaDescription, buildEventTitle } from "@/lib/seo-utils";
import { haversineDistance, formatDistance } from "@/lib/geo";
import { TrackedLink } from "@/components/TrackedLink";
import { OutboundEventLink } from "@/components/OutboundEventLink";
import { getPromoterResponseStats } from "@/lib/promoter-stats";
import { StickyApplyBar } from "@/components/events/StickyApplyBar";
import { FavoriteButton } from "@/components/FavoriteButton";
import { EventCard } from "@/components/events/event-card";
import { DetailPageTracker } from "@/components/DetailPageTracker";
import { ScrollDepthTracker } from "@/components/ScrollDepthTracker";
import { PrintBeacon } from "@/components/print/PrintBeacon";
import { formatDateMedium } from "@/lib/datetime";
import { cdnImage, OG_EVENT } from "@/lib/cdn-image";

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
    // Get event with venue and promoter. Narrow projection — D1's 100-col
    // result-row cap; see eventJoinProjection for the audit + contract.
    const eventResults = await db
      .select(eventJoinProjection)
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(and(eq(events.slug, unsafeSlug(slug)), isPublicEventStatus()))
      .limit(1);

    if (eventResults.length === 0) return null;

    const eventData = eventResults[0];

    // Get promoter's user
    const promoterUser = eventData.promoter?.userId
      ? await db
          .select({ name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, eventData.promoter.userId))
          .limit(1)
      : [];

    // Get event vendors. Soft-deleted vendors (drizzle/0053) are filtered
    // out — the entry hides entirely from the event's vendor lineup per the
    // delete_vendor UX contract.
    // Sorted alphabetically (case-insensitive via COLLATE NOCASE) by
    // businessName so the public lineup is stable across page loads and
    // mixed-case names sort naturally — pre-fix it was rowid/insertion
    // order (PR #161), then BINARY-collation alphabetical (PR #162, which
    // landed "AccuTech" after all all-uppercase names).
    const eventVendorResults = await db
      .select()
      .from(eventVendors)
      .leftJoin(vendors, eq(eventVendors.vendorId, vendors.id))
      .where(
        and(
          eq(eventVendors.eventId, eventData.events.id),
          isPublicVendorStatus(),
          isNull(vendors.deletedAt)
        )
      )
      .orderBy(sql`${vendors.businessName} COLLATE NOCASE`);

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

    // venue/promoter are the lite projection from eventJoinProjection;
    // cast back to the schema row type so consumer prop types compile
    // unchanged. Sound because every venue/promoter field consumers
    // actually read is present in the projection (audit 2026-06-04).
    type FullVenue = typeof venues.$inferSelect;
    type FullPromoter = typeof promoters.$inferSelect;
    return {
      ...eventData.events,
      venue: eventData.venue as FullVenue | null,
      promoter: eventData.promoter
        ? {
            ...(eventData.promoter as FullPromoter),
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
    // REL1' §1 (2026-06-04): throw FetchError on query failure so
    // Next.js routes to error.tsx (service-unavailable), NOT notFound()
    // which would emit 404 and tell crawlers the page no longer exists.
    // Returning null here would force the caller into notFound(),
    // confusing transient outage with permanent delete. Genuine
    // empty-row case is handled inline above (`return null` on length=0).
    const { FetchError } = await import("@/lib/errors/fetch-error");
    throw new FetchError("app/events/[slug]/page.tsx:getEvent", e);
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
    // A2 (Dev backlog 2026-06-05): upcoming branch uses the 24h end-of-day
    // grace per upcomingEndPredicate. Past branch stays strict lt() since
    // an event with end_date in the past is unambiguously past.
    const dateCondition = isPastEvent
      ? lt(events.endDate, new Date())
      : upcomingEndPredicate(new Date());
    const baseConditions = [ne(events.id, eventId), isPublicEventStatus(), dateCondition];

    // Both branches use the narrow projection (D1 100-col cap); see
    // eventJoinProjection. The cast back to full row types keeps the
    // EventsView prop contract intact.
    type FullVenue = typeof venues.$inferSelect;
    type FullPromoter = typeof promoters.$inferSelect;

    // Try same venue first
    if (venueId) {
      const sameVenue = await db
        .select(eventJoinProjection)
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .leftJoin(promoters, eq(events.promoterId, promoters.id))
        .where(and(...baseConditions, eq(events.venueId, venueId)))
        .orderBy(events.startDate)
        .limit(4);

      if (sameVenue.length >= 2) {
        // EventRow derived from sameVenue so any projection change
        // flows through automatically.
        type EventRow = (typeof sameVenue)[number];
        return {
          heading: "More Events at This Venue",
          events: sameVenue.map((r: EventRow) => ({
            ...r.events,
            venue: r.venue as FullVenue | null,
            promoter: r.promoter as FullPromoter | null,
          })),
        };
      }
    }

    // Fallback: same category
    const primaryCategory = categories[0];
    if (primaryCategory) {
      const sameCategory = await db
        .select(eventJoinProjection)
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .leftJoin(promoters, eq(events.promoterId, promoters.id))
        .where(and(...baseConditions, like(events.categories, `%${primaryCategory}%`)))
        .orderBy(events.startDate)
        .limit(4);

      if (sameCategory.length > 0) {
        // EventRow derived from sameCategory (same projection shape
        // as sameVenue above; aliased separately so the locally-named
        // result variable stays the source of truth).
        type EventRow = (typeof sameCategory)[number];
        return {
          heading: `More ${primaryCategory} Events`,
          events: sameCategory.map((r: EventRow) => ({
            ...r.events,
            venue: r.venue as FullVenue | null,
            promoter: r.promoter as FullPromoter | null,
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

  const title = buildEventTitle(event);
  const description = buildEventMetaDescription(event);
  const url = `https://meetmeatthefair.com/events/${event.slug}`;

  return {
    title,
    description,
    alternates: {
      canonical: url,
    },
    openGraph: {
      title,
      description,
      url,
      siteName: "Meet Me at the Fair",
      // `og:type` set via `other` below. OG protocol supports "event" but
      // Next.js's openGraph.type union doesn't. Tried `type: "event" as never`
      // (PR #135, 2026-05-11) to emit canonical `property=` — but Next.js's
      // openGraph serializer throws on the unknown discriminant and silently
      // skips ALL metadata generation, breaking every page. Reverted same day
      // (PR #136). `other` emits `name="og:type"` which is non-canonical:
      // Google honors both attribute forms, but Facebook's Sharing Debugger
      // only honors `property=` and flags `name=` as a warning (confirmed by
      // audit 2026-05-11). Accepted trade-off: cosmetic FB warning vs. risk
      // of re-breaking site-wide metadata. See
      // feedback_nextjs_metadata_type_cast_runtime.md.
      images: [
        {
          // Static OG fallback — `/api/og` dynamic generator removed
          // 2026-06-04 to keep the main-app Worker under the 25 MiB
          // Cloudflare bundle cap (satori + resvg-wasm was ~476 KiB
          // compiled). 81% of events have no per-event image so this
          // was the common case; matches every other index page.
          //
          // IMG1 (2026-06-07) — both real images and the og-default are
          // now routed through `cdn-cgi/image` so social previews get
          // exactly the 1200×630 derivative with `gravity=auto` smart
          // crop (saves the 1942×809 panorama case where the old raw
          // URL forced platforms to letterbox/zoom).
          url: cdnImage(event.imageUrl || "https://meetmeatthefair.com/og-default.png", OG_EVENT),
          width: 1200,
          height: 630,
          alt: title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [cdnImage(event.imageUrl || "https://meetmeatthefair.com/og-default.png", OG_EVENT)],
    },
    other: {
      "og:type": "event",
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

  // FAQ Phase A: only render for events in the FAQ_PILOT_EVENT_SLUGS env
  // allowlist. Visible section and JSON-LD share this array verbatim — see
  // MMATF-FAQ-Strategy.md §8.
  const faqItems = isFaqPilotEvent(event.slug)
    ? buildEventFaqItems({
        event,
        venue: event.venue,
        eventDays: event.eventDays,
      })
    : [];

  return (
    <>
      {/* PRINT1 (2026-06-08) — purpose-built print sheet. `hidden print:block`
          inside the component; rendered first in document order so a long
          screen page doesn't have to scroll past on tab/keyboard nav. */}
      <PrintEventSheet
        event={{
          name: event.name,
          slug: event.slug,
          description: event.description,
          startDate: event.startDate,
          endDate: event.endDate,
          discontinuousDates: event.discontinuousDates,
          eventDays: event.eventDays,
        }}
        venue={event.venue}
        promoter={event.promoter ? { name: event.promoter.companyName } : null}
      />
      {/* `screen-only` class is the inverse of `.print-sheet`: hidden on
          print via globals.css. Keeps all screen DOM unchanged so screen
          a11y / rendering is unaffected by the print template. */}
      <div className="screen-only mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        <DetailPageTracker type="event" slug={event.slug} name={event.name} />
        <ScrollDepthTracker pageType="event-detail" />
        {/* PRINT2 (2026-06-09) — listens for window.beforeprint so it
            catches both the in-page Print button and Ctrl+P/Cmd+P. */}
        <PrintBeacon entityType="EVENT" entityId={event.id} entitySlug={event.slug} />
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
                  timezone: event.venue.timezone,
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
          ticketPriceMinCents={event.ticketPriceMinCents}
          ticketPriceMaxCents={event.ticketPriceMaxCents}
          ticketUrl={event.ticketUrl}
          categories={parseJsonArray(event.categories)}
          datesConfirmed={event.datesConfirmed}
          lifecycleStatus={event.lifecycleStatus}
          previousStartDate={event.previousStartDate}
          previousEndDate={event.previousEndDate}
          eventDays={event.eventDays}
          vendors={event.eventVendors.slice(0, 10).map((ev) => ({
            name: ev.vendor.businessName,
            url: `https://meetmeatthefair.com/vendors/${ev.vendor.slug}`,
            // Drives schema.org performer-vs-sponsor placement (drizzle/0071).
            participationType: ev.participationType as
              | "EXHIBITOR"
              | "SPONSOR_ONLY"
              | "SPONSOR_AND_EXHIBITOR"
              | undefined,
            // K18 Phase 2 (2026-06-06): per-occurrence scoping. NULL = series-
            // wide -> appears in top-level performer/sponsor arrays. Non-NULL
            // = scoped to that occurrence -> EventSchema emits the vendor
            // under the matching subEvent's performer/sponsor array instead.
            eventDayId: ev.eventDayId ?? null,
          }))}
          createdAt={event.createdAt}
          // TAX1 Phase 3 (2026-06-02). Audience/access drives the
          // schema.org `audience` block + offers suppression for CLOSED
          // events (the SEO accuracy lever per A7). When the columns
          // are PUBLIC + OPEN (the default for the ~95% majority),
          // EventSchema emits the same shape as pre-TAX1 — no
          // behavior change.
          primaryAudience={event.primaryAudience}
          publicAccess={event.publicAccess}
          accessNotes={event.accessNotes}
        />
        <BreadcrumbSchema
          items={[
            { name: "Home", url: "https://meetmeatthefair.com" },
            { name: "Events", url: "https://meetmeatthefair.com/events" },
            { name: event.name, url: `https://meetmeatthefair.com/events/${event.slug}` },
          ]}
        />
        <FAQPageSchema items={faqItems} />
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
            {/* UX-A1 item 1 (2026-06-04) — 3-tier hero fallback. Was: rendered
              nothing when event.imageUrl was null (which is 81% of events
              per the U9 audit — 179/946 have an image). Now:
                Tier 1: real imageUrl (existing path, unchanged)
                Tier 2: location card — venue name + city/state on a
                        category-tinted background, with a "View on Map"
                        link. Used when no imageUrl AND venue has coords
                        (~90% of venues).
                Tier 3: category banner — pure tinted card with category
                        name in large type. Used when no imageUrl AND no
                        venue coords (the rarest case).
              No external map tiles in tiers 2/3 to keep the page edge-
              renderable without new deps. Tier 2's "View on Map" link
              still routes to the existing Google Maps URL elsewhere on
              the page. */}
            {(() => {
              const categoryColors = getCategoryColors(parseJsonArray(event.categories));
              if (event.imageUrl) {
                // IMG1 §1b (2026-06-08) — blurred-fill hero (no crop).
                //
                // History of this hero's cropping fix:
                //   1. Pre-IMG1: the source was rendered via <Image fill
                //      object-cover>. A 1942×809 panorama in a 16:9 box lost
                //      ~26% of its width to dumb client-side center-crop.
                //      Kingfield (`kingfield-first-friday-artwalk-2026`) was
                //      the spec's named-bug example.
                //   2. First fix (commit 248b854, deployed 13:59Z 2026-06-08):
                //      moved cropping server-side via `fit=cover,gravity=auto`
                //      so Cloudflare's saliency algorithm picked the crop
                //      window. PROBLEM: for poster/text-heavy heroes (which
                //      describes Kingfield — title text on the left edge,
                //      figure illustration on the right), saliency latches
                //      onto the figure and shifts the crop further right,
                //      making it WORSE than center-crop (cuts off "KIN" of
                //      KINGFIELD on the left + "FREE • EVERY" on the bottom).
                //      Smart-crop optimizes for the wrong thing when the
                //      whole image is the content.
                //   3. This fix: don't crop at all. Show the full image with
                //      `object-contain`, fill the surrounding box space with
                //      a blurred-scaled copy of the same image as a decorative
                //      backdrop. Spec §1b calls this out as "Optional polish
                //      for odd ratios — blurred-fill backdrop preserves the
                //      whole image with no letterbox bars — good for a
                //      directory of unpredictable image shapes." Event hero
                //      images ARE unpredictable shapes (scraped + uploaded
                //      mix, poster + photo mix), so this default fits the
                //      whole cohort, not just the Kingfield case.
                //
                // Why a raw `<img>` instead of `<Image>`: the next/image
                // custom loader signature can't pass `fit`/`gravity`/`height`
                // per call, and we're emitting two image elements (backdrop
                // + foreground) where the simpler raw-img + cdnImage pattern
                // is cheapest. LCP preserved via `fetchpriority="high"` +
                // `loading="eager"` directly on the foreground <img>.
                //
                // Bytes: foreground responsive srcSet uses plain width-only
                // resizes (no crop params — `object-contain` does no cropping,
                // we just need the right pixel density per viewport). Backdrop
                // is a single tiny 200w blurred copy — CSS blur masks the
                // pixelation, and `scale-110` prevents the blur halo from
                // showing the box edge.
                const heroWidths = [400, 640, 800, 1200, 1600, 1942];
                const heroSrcSet = heroWidths
                  .map((w) =>
                    cdnImage(event.imageUrl!, {
                      width: w,
                      format: "auto",
                      quality: 80,
                      onerror: "redirect",
                    })
                  )
                  .map((url, i) => `${url} ${heroWidths[i]}w`)
                  .join(", ");
                const heroSrc = cdnImage(event.imageUrl, {
                  width: 1600,
                  format: "auto",
                  quality: 80,
                  onerror: "redirect",
                });
                const backdropSrc = cdnImage(event.imageUrl, {
                  width: 200,
                  format: "auto",
                  quality: 60,
                  onerror: "redirect",
                });
                return (
                  <div className="aspect-video rounded-xl overflow-hidden bg-muted relative">
                    {/* Blurred backdrop — decorative, fills the box. Marked
                      aria-hidden because the foreground <img> already
                      carries the accessible alt text.

                      Skip when cdnImage couldn't produce a meaningfully
                      smaller backdrop URL (unknown foreign host with no
                      host-side resize convention). Without this skip, the
                      backdrop would be a duplicate full-res download just
                      for the blur effect; bg-muted shows through fine. */}
                    {backdropSrc !== heroSrc && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={backdropSrc}
                        alt=""
                        aria-hidden="true"
                        data-hero-backdrop
                        className="absolute inset-0 w-full h-full object-cover scale-110 blur-2xl"
                      />
                    )}
                    {/* Foreground — full image, no crop. `object-contain`
                      letterboxes; the blurred backdrop fills the bars so
                      they don't look empty. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={heroSrc}
                      srcSet={heroSrcSet}
                      sizes="(max-width: 1024px) 100vw, 66vw"
                      alt={event.name}
                      fetchPriority="high"
                      loading="eager"
                      decoding="async"
                      className="relative w-full h-full object-contain"
                    />
                  </div>
                );
              }
              const hasCoords = !!(event.venue?.latitude && event.venue?.longitude);
              if (hasCoords && event.venue) {
                const mapsUrl =
                  event.venue.googleMapsUrl ||
                  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                    `${event.venue.name}, ${event.venue.address}, ${event.venue.city}, ${event.venue.state}`
                  )}`;
                return (
                  <div
                    className={`aspect-video rounded-xl overflow-hidden ${categoryColors.bg} relative flex items-center justify-center`}
                  >
                    <div className="text-center px-6">
                      <MapPin
                        className={`w-12 h-12 ${categoryColors.icon} mx-auto mb-3`}
                        aria-hidden="true"
                      />
                      <p className={`text-xl font-semibold ${categoryColors.icon}`}>
                        {event.venue.name}
                      </p>
                      <p className={`text-sm ${categoryColors.icon} opacity-80 mt-1`}>
                        {event.venue.city}, {event.venue.state}
                      </p>
                      <a
                        href={mapsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`inline-flex items-center gap-1 mt-3 text-sm ${categoryColors.icon} underline hover:no-underline`}
                      >
                        View on Map <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  </div>
                );
              }
              // Tier 3 — pure category banner. Last-resort but still
              // branded; never the gray void that was previously shown.
              const primaryCategory = parseJsonArray(event.categories)[0] || "Event";
              return (
                <div
                  className={`aspect-video rounded-xl overflow-hidden ${categoryColors.bg} relative flex items-center justify-center`}
                >
                  <div className="text-center px-6">
                    <Tag
                      className={`w-12 h-12 ${categoryColors.icon} mx-auto mb-3`}
                      aria-hidden="true"
                    />
                    <p className={`text-2xl font-semibold ${categoryColors.icon}`}>
                      {primaryCategory}
                    </p>
                    <p className={`text-sm ${categoryColors.icon} opacity-80 mt-1`}>
                      Event details below
                    </p>
                  </div>
                </div>
              );
            })()}

            {(() => {
              const categories = parseJsonArray(event.categories);
              const tags = parseJsonArray(event.tags);
              // UX-A1 item 4 (2026-06-04) — extended INTERNAL_TAGS to suppress
              // operational/admin tags that don't belong on the public chip row.
              // The earlier set covered ingest-source tags; the additions here
              // catch scheduling-shape ("weekends-only"), workflow-state
              // ("needs-review"), and admin-flag ("dedup-suspect") tags that
              // operators apply for internal triage. Tags containing `.` are
              // already excluded (versioned/qualified, e.g. "fmt.v2").
              const INTERNAL_TAGS = new Set([
                // Ingest-source
                "imported",
                "url-import",
                "community-suggestion",
                "vendor-submission",
                // Scheduling-shape (UX-A1)
                "weekends-only",
                "weekdays-only",
                "recurring",
                "ongoing",
                // Workflow/admin (UX-A1)
                "needs-review",
                "needs-image",
                "needs-dates",
                "dedup-suspect",
                "draft",
                "internal",
              ]);
              const publicTags = tags.filter(
                (tag) =>
                  !INTERNAL_TAGS.has(tag) &&
                  !tag.includes(".") &&
                  // Hide anything obviously admin-prefixed (e.g. "admin:hold").
                  !tag.startsWith("admin:") &&
                  !tag.startsWith("internal:")
              );
              return (
                <>
                  <div>
                    <div className="flex flex-wrap gap-2 mb-3">
                      {event.featured && <Badge variant="warning">Featured</Badge>}
                      {event.status === "TENTATIVE" && (
                        <Badge variant="info">Tentative — Unverified</Badge>
                      )}
                      {/* TAX1 Phase 3 (2026-06-02) — A6 audience/access label.
                        Renders only for non-default audience/access pairs
                        (MEMBERS, TRADE, CLOSED variants). PUBLIC + OPEN
                        events show no badge per the dev-email spec
                        ("avoid clutter"). */}
                      {(() => {
                        const audienceBadge = formatAudienceBadge(
                          event.primaryAudience,
                          event.publicAccess,
                          event.accessNotes
                        );
                        return audienceBadge ? (
                          <Badge variant={audienceBadge.variant}>{audienceBadge.label}</Badge>
                        ) : null;
                      })()}
                      {categories.map((cat) => (
                        <Badge key={cat} className={getCategoryBadgeClass(cat)}>
                          {cat}
                        </Badge>
                      ))}
                    </div>
                    <div className="flex items-start justify-between gap-4">
                      <h1 className="text-3xl md:text-4xl font-bold text-foreground">
                        {event.name}
                      </h1>
                      <div className="flex items-center gap-2 print:hidden">
                        <FavoriteButton type="EVENT" id={event.id} size="lg" />
                        <ShareButtons
                          url={`https://meetmeatthefair.com/events/${event.slug}`}
                          title={event.name}
                          description={event.description || undefined}
                          entityType="EVENT"
                          entityId={event.id}
                          entitySlug={event.slug}
                        />
                        {/* MMATF-UIUX-PrintSheet-Spec Item 1 — paper handoff
                          for the fairs audience. Single button triggers
                          window.print(); modern browsers offer "Save as
                          PDF" in the same dialog so we don't need a
                          separate Download PDF button. */}
                        <PrintButton label="Print" />
                      </div>
                    </div>
                    {(event.viewCount ?? 0) > 10 && (
                      <p
                        data-view-count
                        className="text-sm text-muted-foreground flex items-center gap-1 mt-1 print:hidden"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        {(event.viewCount ?? 0).toLocaleString()} views
                      </p>
                    )}
                  </div>

                  <div className="prose prose-gray max-w-none">
                    <p className="text-muted-foreground whitespace-pre-wrap">
                      {event.description || "No description available."}
                    </p>
                  </div>

                  {publicTags.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {publicTags.map((tag) => (
                        <span
                          key={tag}
                          className="px-2 py-1 bg-muted text-muted-foreground text-sm rounded"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}

            <EventFAQSection items={faqItems} />

            <SameDayEventsButton
              slug={event.slug}
              startDate={event.startDate}
              endDate={event.endDate}
            />

            {event.eventVendors.length > 0 &&
              (() => {
                // Split the vendor lineup by participation_type (drizzle/0071,
                // 2026-05-16 analyst spec). Per Q3 decision: vendors with
                // SPONSOR_AND_EXHIBITOR appear in BOTH sections; the
                // Exhibitors-section card shows a small "Sponsor" badge to
                // signal cross-membership without burying the sponsor info.
                // Alphabetical sort within each section comes from the
                // upstream query order (event-vendor list sorted by businessName
                // COLLATE NOCASE — see memory project_event_lifecycle.md).
                //
                // K18 Phase 2 (drizzle/0114, 2026-06-06): within each section
                // we layer one MORE split — by event_day_id. groupVendorsByDay
                // suppresses headings entirely when the lineup is purely
                // series-wide (today's data, all event_day_id IS NULL), so
                // pre-K18 events render exactly as before. When per-day links
                // exist, "Regular participants" appears first, then each date
                // chronologically.
                type EvRow = (typeof event.eventVendors)[number];
                const isExhib = (ev: EvRow) =>
                  ev.participationType === "EXHIBITOR" ||
                  ev.participationType === "SPONSOR_AND_EXHIBITOR" ||
                  // Legacy rows that pre-date the column default to EXHIBITOR
                  // semantics. Treat undefined / null the same way.
                  ev.participationType == null;
                const isSponsor = (ev: EvRow) =>
                  ev.participationType === "SPONSOR_ONLY" ||
                  ev.participationType === "SPONSOR_AND_EXHIBITOR";

                const exhibitors = event.eventVendors.filter(isExhib);
                const sponsors = event.eventVendors.filter(isSponsor);

                const exhibitorGroups = groupVendorsByDay(exhibitors, event.eventDays);
                const sponsorGroups = groupVendorsByDay(sponsors, event.eventDays);

                const renderVendorCard = (ev: EvRow, showSponsorBadge: boolean) => (
                  <Link
                    key={ev.vendor.id}
                    href={`/vendors/${ev.vendor.slug}`}
                    className="flex items-center gap-3 p-3 rounded-lg hover:bg-muted transition-colors"
                  >
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center relative overflow-hidden">
                      {ev.vendor.logoUrl ? (
                        <Image
                          src={ev.vendor.logoUrl}
                          alt={ev.vendor.businessName}
                          fill
                          sizes="40px"
                          className="object-cover"
                        />
                      ) : (
                        <Store className="w-5 h-5 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-foreground flex items-center gap-2">
                        <span className="truncate">{ev.vendor.businessName}</span>
                        {/* UX-R3 (2026-06-07) — semantic-token migration. Shape kept
                          custom (text-[10px], rounded not rounded-full) to preserve
                          the inline-with-business-name layout; only the color pair
                          moves to amber-light + amber-bg-fg (~17:1 contrast). */}
                        {showSponsorBadge && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-amber-light text-amber-bg-fg">
                            Sponsor
                          </span>
                        )}
                      </p>
                      {ev.vendor.vendorType && (
                        <p className="text-sm text-muted-foreground truncate">
                          {ev.vendor.vendorType}
                        </p>
                      )}
                    </div>
                  </Link>
                );

                // Render a single group's vendor cards (with optional heading
                // when grouping is active). When `heading` is empty string,
                // the group is the only group (pre-K18-style flat render) and
                // we skip the heading + extra wrapper.
                const renderGroupBody = (
                  group: (typeof exhibitorGroups)[number],
                  renderBadge: (ev: EvRow) => boolean,
                  takeLimit: number | null
                ) => {
                  const cards = (
                    takeLimit != null ? group.vendors.slice(0, takeLimit) : group.vendors
                  ).map((ev) => renderVendorCard(ev, renderBadge(ev)));
                  if (group.heading === "") {
                    return <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{cards}</div>;
                  }
                  return (
                    <div key={group.key} className="space-y-3">
                      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                        {group.heading}
                      </h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{cards}</div>
                    </div>
                  );
                };

                return (
                  <>
                    {exhibitors.length > 0 && (
                      <Card>
                        <CardHeader>
                          <div className="flex items-center justify-between">
                            <h2 className="text-xl font-semibold text-foreground flex items-center gap-2">
                              <Store className="w-5 h-5" />
                              Exhibitors ({exhibitors.length})
                            </h2>
                            {exhibitors.length > 8 && (
                              <Link
                                href={`/events/${event.slug}/vendors`}
                                className="text-sm text-royal hover:text-navy font-medium"
                              >
                                View all
                              </Link>
                            )}
                          </div>
                        </CardHeader>
                        <CardContent>
                          {exhibitorGroups.length === 1 && exhibitorGroups[0].heading === "" ? (
                            // Pre-K18 / single-day path -- render flat, exactly as before.
                            renderGroupBody(
                              exhibitorGroups[0],
                              (ev) => ev.participationType === "SPONSOR_AND_EXHIBITOR",
                              8
                            )
                          ) : (
                            // K18 grouped path -- one section per group, with headings.
                            // No per-group cap here; the section-level "View all"
                            // link absorbs the size for events with deep lineups.
                            <div className="space-y-6">
                              {exhibitorGroups.map((group) =>
                                renderGroupBody(
                                  group,
                                  (ev) => ev.participationType === "SPONSOR_AND_EXHIBITOR",
                                  null
                                )
                              )}
                            </div>
                          )}
                          {exhibitors.length > 8 && exhibitorGroups.length === 1 && (
                            <div className="mt-4 text-center">
                              <Link
                                href={`/events/${event.slug}/vendors`}
                                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-royal hover:text-navy hover:bg-brand-blue-light rounded-lg transition-colors"
                              >
                                View all {exhibitors.length} exhibitors
                              </Link>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    )}

                    {sponsors.length > 0 && (
                      <Card>
                        <CardHeader>
                          <h2 className="text-xl font-semibold text-foreground flex items-center gap-2">
                            <Store className="w-5 h-5" />
                            Sponsors ({sponsors.length})
                          </h2>
                        </CardHeader>
                        <CardContent>
                          {sponsorGroups.length === 1 && sponsorGroups[0].heading === "" ? (
                            renderGroupBody(sponsorGroups[0], () => false, 8)
                          ) : (
                            <div className="space-y-6">
                              {sponsorGroups.map((group) =>
                                renderGroupBody(group, () => false, null)
                              )}
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    )}
                  </>
                );
              })()}
          </main>

          <aside className="space-y-6">
            <Card>
              <CardContent className="p-6 space-y-4">
                {/* UX-A1 item 2 (V1, 2026-06-04) — dropped the decorative
                  Calendar icon that sat to the left of the date text. The
                  AddToCalendar button inside the same row already renders
                  a calendar icon; having two calendars side-by-side read
                  as a duplicate to users in the working-notes review.
                  Date text aligns flush-left instead. */}
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <p className="font-medium text-foreground">
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
                        eventSlug={event.slug}
                        eventDays={event.eventDays}
                      />
                    </div>
                    {event.eventDays && event.eventDays.length > 0 ? (
                      <>
                        {/* E.2a (F2 public consumer, 2026-06-09) — per-
                            occurrence art for events that ship day-
                            specific images via PR #412's schema. Renders
                            null when no day has imageUrl set, so this
                            adds zero visual weight to the 99%+ of events
                            that don't use the feature yet. */}
                        <EventDayImageStrip days={event.eventDays} className="mt-3" />
                        <DailyScheduleDisplay
                          days={event.eventDays}
                          discontinuousDates={event.discontinuousDates ?? false}
                          className="mt-2"
                          showVendorDays={isAdmin ? "all" : isVendor ? "badge" : "hide"}
                        />
                      </>
                    ) : event.discontinuousDates ? (
                      // Season-span case (analyst P7b sub-case): discontinuousDates
                      // is set but no event_days back it (e.g., "every Saturday
                      // May–October" stored as just a start/end range with the
                      // flag). Give the user a recurring/periodic cue rather
                      // than letting the bare multi-month range carry no signal.
                      <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
                        <Clock className="w-4 h-4" />
                        Recurring event — see description for specific dates
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
                        <Clock className="w-4 h-4" />
                        Hours not listed — check with organizer
                      </p>
                    )}
                  </div>
                </div>

                {event.venue ? (
                  <div className="flex items-start gap-3">
                    <MapPin className="w-5 h-5 text-royal mt-0.5" />
                    <div>
                      <Link
                        href={`/venues/${event.venue.slug}`}
                        className="font-medium text-foreground hover:text-navy"
                      >
                        {event.venue.name}
                      </Link>
                      <p className="text-sm text-muted-foreground">
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
                    <MapPin className="w-5 h-5 text-muted-foreground mt-0.5" />
                    <div>
                      <p className="text-sm text-muted-foreground">Venue to be announced</p>
                    </div>
                  </div>
                )}

                <div className="flex items-start gap-3">
                  <Tag className="w-5 h-5 text-royal mt-0.5" />
                  <div>
                    <p className="font-medium text-foreground">
                      {formatPrice(event.ticketPriceMinCents, event.ticketPriceMaxCents)}
                    </p>
                  </div>
                </div>

                {/* Vendor Decision Fields */}
                {(event.vendorFeeMinCents != null || event.vendorFeeMaxCents != null) && (
                  <div className="flex items-start gap-3">
                    <DollarSign className="w-5 h-5 text-green-600 mt-0.5" />
                    <div>
                      <p className="text-sm text-muted-foreground">Vendor/Booth Fee</p>
                      <p className="font-medium text-foreground">
                        {formatPrice(event.vendorFeeMinCents, event.vendorFeeMaxCents)}
                      </p>
                      {event.vendorFeeNotes && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {event.vendorFeeNotes}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {event.indoorOutdoor && (
                  <div className="flex items-start gap-3">
                    {event.indoorOutdoor === "INDOOR" ? (
                      <Home className="w-5 h-5 text-royal mt-0.5" />
                    ) : (
                      <Trees className="w-5 h-5 text-green-500 mt-0.5" />
                    )}
                    <div>
                      <p className="font-medium text-foreground">
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
                        <p className="font-medium text-foreground">
                          ~{event.estimatedAttendance.toLocaleString()} attendees
                        </p>
                      )}
                      {event.eventScale && (
                        <p className="text-sm text-muted-foreground">
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
                      <p className="font-medium text-foreground">Walk-in Vendors Welcome</p>
                    </div>
                  </div>
                )}

                {(event.applicationDeadline ||
                  event.applicationUrl ||
                  event.applicationInstructions) && (
                  <div className="flex items-start gap-3">
                    <FileText className="w-5 h-5 text-amber-500 mt-0.5" />
                    <div>
                      <p className="text-sm text-muted-foreground">Vendor Applications</p>
                      {event.applicationDeadline && (
                        <p
                          className={`text-sm font-medium ${new Date(event.applicationDeadline) < new Date() ? "text-destructive" : "text-foreground"}`}
                        >
                          Deadline: {formatDateMedium(event.applicationDeadline)}
                          {new Date(event.applicationDeadline) < new Date() && " (Passed)"}
                        </p>
                      )}
                      {event.applicationInstructions && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {event.applicationInstructions}
                        </p>
                      )}
                      {event.applicationUrl && (
                        <OutboundEventLink
                          kind="application"
                          eventSlug={event.slug}
                          href={event.applicationUrl}
                          className="text-sm text-royal hover:underline mt-1 inline-block"
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
                  <div data-admin-controls className="space-y-2 mt-3 pt-3 border-t print:hidden">
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
                  <h3 className="font-semibold text-foreground flex items-center gap-2">
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
                      <p className="text-sm text-muted-foreground mt-2">
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
                      <p className="text-sm text-muted-foreground">
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
                  <Store className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground mb-3">Are you a vendor?</p>
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
                  <h3 className="font-semibold text-foreground">Presented By</h3>
                </CardHeader>
                <CardContent>
                  <Link
                    href={`/promoters/${event.promoter.slug}`}
                    className="flex items-center gap-3 group"
                  >
                    <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center relative overflow-hidden">
                      {event.promoter.logoUrl ? (
                        <Image
                          src={event.promoter.logoUrl}
                          alt={event.promoter.companyName}
                          fill
                          sizes="48px"
                          className="object-cover"
                        />
                      ) : (
                        <User className="w-6 h-6 text-muted-foreground" />
                      )}
                    </div>
                    <div>
                      <p className="font-medium text-foreground group-hover:text-royal">
                        {event.promoter.companyName}
                      </p>
                      {/* Strict equality so any non-true value (legacy 0,
                        unexpected string) renders nothing instead of leaking
                        a stray "false" into the DOM. */}
                      {event.promoter.verified === true && (
                        <Badge variant="success">Verified</Badge>
                      )}
                    </div>
                  </Link>
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
          <div className="mt-12 border-t border-border pt-8">
            <h2 className="text-2xl font-bold text-foreground mb-6">{relatedEvents.heading}</h2>
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
          links. See Phase: content-entity link index.

          `print:hidden` — carousels are explicitly excluded per
          MMATF-UIUX-PrintSheet-Spec ("Strip all site chrome
          (nav/footer/carousels)"). */}
        {relatedBlogPosts.length > 0 && (
          <div className="mt-12 border-t border-border pt-8 print:hidden">
            <h2 className="text-2xl font-bold text-foreground mb-6">Related Blog Posts</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {relatedBlogPosts.map((post) => (
                <Link
                  key={post.slug}
                  href={`/blog/${post.slug}`}
                  className="p-4 bg-card rounded-lg border border-border hover:border-amber hover:shadow-sm transition-all group"
                >
                  {post.kind === "direct" && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 mb-2 rounded-full text-[11px] font-medium bg-amber-light text-amber-bg-fg">
                      Written about this event
                    </span>
                  )}
                  <p className="font-medium text-foreground group-hover:text-navy line-clamp-2">
                    {post.title}
                  </p>
                  {post.excerpt && (
                    <p className="text-sm text-muted-foreground mt-2 line-clamp-2">
                      {post.excerpt}
                    </p>
                  )}
                  {post.publishDate && (
                    <p className="text-xs text-muted-foreground mt-2">
                      {formatDateMedium(post.publishDate)}
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

        {/* MMATF-UIUX-PrintSheet-Spec — static map "visual anchor" for
          the printed event sheet. Hidden on screen (the existing
          inline event-detail venue card serves the "where" question
          on screen). Rendered only when venue coords exist; ~90% of
          events have lat/lng per spec, so this lands on most sheets.

          Routes through /api/static-map (a server-side proxy) so the
          GOOGLE_MAPS_API_KEY stays out of client-visible HTML. See
          that route's docblock for the rationale.

          PRINT1 (2026-06-08): standalone <PrintEventMap> + <PrintEventSheetFooter>
          retired from this position; both are now composed inside the
          purpose-built <PrintEventSheet> rendered at the top of the
          page. Screen DOM no longer needs them as siblings — the v2
          template owns the entire print surface. */}
      </div>
    </>
  );
}
