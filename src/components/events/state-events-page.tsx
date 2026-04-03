import Link from "next/link";
import { MapPin } from "lucide-react";
import { EventsView } from "@/components/events/events-view";
import { getCloudflareDb } from "@/lib/cloudflare";
import {
  events,
  venues,
  promoters,
  eventVendors,
  vendors,
} from "@/lib/db/schema";
import { eq, and, gte, or, isNull, count, inArray } from "drizzle-orm";
import { isPublicVendorStatus } from "@/lib/vendor-status";
import { isPublicEventStatus } from "@/lib/event-status";
import { ItemListSchema } from "@/components/seo/ItemListSchema";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { getStateColors } from "@/lib/state-colors";

export const STATE_MAP: Record<
  string,
  { code: string; name: string }
> = {
  maine: { code: "ME", name: "Maine" },
  vermont: { code: "VT", name: "Vermont" },
  "new-hampshire": { code: "NH", name: "New Hampshire" },
  massachusetts: { code: "MA", name: "Massachusetts" },
};

async function getStateEvents(
  stateCode: string,
  page: number,
  limit: number
) {
  const db = getCloudflareDb();
  const offset = (page - 1) * limit;

  const conditions = [
    isPublicEventStatus(),
    or(gte(events.endDate, new Date()), isNull(events.endDate))!,
    eq(venues.state, stateCode),
  ];

  const results = await db
    .select()
    .from(events)
    .innerJoin(venues, eq(events.venueId, venues.id))
    .leftJoin(promoters, eq(events.promoterId, promoters.id))
    .where(and(...conditions))
    .orderBy(events.startDate)
    .limit(limit)
    .offset(offset);

  // Batch-fetch vendors
  const eventIds = results.map((r) => r.events.id);
  const allEventVendors: {
    eventId: string;
    vendorId: string;
    businessName: string;
    slug: string;
    logoUrl: string | null;
    vendorType: string | null;
  }[] = [];

  if (eventIds.length > 0) {
    const BATCH_SIZE = 50;
    for (let i = 0; i < eventIds.length; i += BATCH_SIZE) {
      const batch = eventIds.slice(i, i + BATCH_SIZE);
      const batchResults = await db
        .select({
          eventId: eventVendors.eventId,
          vendorId: vendors.id,
          businessName: vendors.businessName,
          slug: vendors.slug,
          logoUrl: vendors.logoUrl,
          vendorType: vendors.vendorType,
        })
        .from(eventVendors)
        .innerJoin(vendors, eq(eventVendors.vendorId, vendors.id))
        .where(
          and(inArray(eventVendors.eventId, batch), isPublicVendorStatus())
        );
      allEventVendors.push(...batchResults);
    }
  }

  const vendorsByEvent = new Map<string, typeof allEventVendors>();
  for (const ev of allEventVendors) {
    const existing = vendorsByEvent.get(ev.eventId) || [];
    existing.push(ev);
    vendorsByEvent.set(ev.eventId, existing);
  }

  const eventsWithVendors = results.map((r) => ({
    ...r.events,
    venue: r.venues,
    promoter: r.promoters,
    vendors: (vendorsByEvent.get(r.events.id) || []).map((ev) => ({
      id: ev.vendorId,
      businessName: ev.businessName,
      slug: ev.slug,
      logoUrl: ev.logoUrl,
      vendorType: ev.vendorType,
    })),
  }));

  const countResult = await db
    .select({ count: count() })
    .from(events)
    .innerJoin(venues, eq(events.venueId, venues.id))
    .where(and(...conditions));

  return {
    events: eventsWithVendors,
    total: countResult[0]?.count || 0,
    page,
    limit,
  };
}

interface StateEventsPageProps {
  stateSlug: string;
  searchParams: { page?: string };
}

export async function StateEventsPage({
  stateSlug,
  searchParams,
}: StateEventsPageProps) {
  const state = STATE_MAP[stateSlug];
  if (!state) return null;

  const page = parseInt(searchParams.page || "1");
  const limit = 12;
  const { events: eventsList, total } = await getStateEvents(
    state.code,
    page,
    limit
  );
  const totalPages = Math.ceil(total / limit);
  const colors = getStateColors(state.code);

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <ItemListSchema
        name={`Fairs & Festivals in ${state.name}`}
        description={`Upcoming fairs, festivals, craft shows, and markets in ${state.name}`}
        items={eventsList.map((e) => ({
          name: e.name,
          url: `https://meetmeatthefair.com/events/${e.slug}`,
          image: e.imageUrl,
        }))}
        asCollectionPage
        pageUrl={`https://meetmeatthefair.com/events/${stateSlug}`}
      />
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Events", url: "https://meetmeatthefair.com/events" },
          { name: state.name, url: `https://meetmeatthefair.com/events/${stateSlug}` },
        ]}
      />

      {/* Hero intro */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div
            className={`w-10 h-10 rounded-lg flex items-center justify-center ${colors.bg}`}
          >
            <MapPin className={`w-5 h-5 ${colors.icon}`} />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-gray-900">
              Fairs & Festivals in {state.name}
            </h1>
          </div>
        </div>
        <p className="mt-2 text-gray-600">
          Browse {total} upcoming fairs, festivals, craft shows, and markets
          across {state.name}.
        </p>
        <nav className="mt-4 text-sm text-gray-500" aria-label="Breadcrumb">
          <Link href="/" className="hover:text-royal">
            Home
          </Link>
          <span className="mx-2">/</span>
          <Link href="/events" className="hover:text-royal">
            Events
          </Link>
          <span className="mx-2">/</span>
          <span className="text-gray-900">{state.name}</span>
        </nav>
      </div>

      {/* Event listing */}
      {eventsList.length > 0 ? (
        <EventsView
          events={eventsList}
          view="cards"
          emptyMessage={`No upcoming events found in ${state.name}. Check back soon!`}
          currentPage={page}
          totalPages={totalPages}
          searchParams={{ state: stateSlug, ...(searchParams.page ? { page: searchParams.page } : {}) }}
          total={total}
        />
      ) : (
        <div className="text-center py-12">
          <MapPin className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-600 text-lg">
            No upcoming events found in {state.name}.
          </p>
          <p className="text-gray-500 mt-2">
            Check back soon or{" "}
            <Link href="/events" className="text-royal hover:text-navy font-medium">
              browse all events
            </Link>
            .
          </p>
        </div>
      )}

      {/* SEO content */}
      {total > 0 && (
        <div className="mt-12 prose prose-gray max-w-none">
          <h2>About Fairs in {state.name}</h2>
          <p>
            {state.name} hosts a vibrant calendar of fairs, festivals, farmers
            markets, and craft shows throughout the year. From county fairs
            celebrating local agriculture to artisan craft fairs showcasing
            handmade goods, there&apos;s always something happening. Browse our
            listings to find events near you, check dates and venues, and
            connect with vendors.
          </p>
        </div>
      )}
    </div>
  );
}
