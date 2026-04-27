import type { Metadata } from "next";
import Link from "next/link";
import { EventsView } from "@/components/events/events-view";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, promoters, eventVendors, vendors } from "@/lib/db/schema";
import { eq, and, lt, count, inArray, desc, sql } from "drizzle-orm";
import { isPublicVendorStatus } from "@/lib/vendor-status";
import { isPublicEventStatus } from "@/lib/event-status";
import { ItemListSchema } from "@/components/seo/ItemListSchema";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Past Fairs & Festivals | Meet Me at the Fair",
  description:
    "Browse past fairs, festivals, and community events across New England. View event details, venues, and vendor information from previous seasons.",
  alternates: { canonical: "https://meetmeatthefair.com/events/past" },
  openGraph: {
    title: "Past Fairs & Festivals | Meet Me at the Fair",
    description: "Browse past fairs, festivals, and community events across New England.",
    url: "https://meetmeatthefair.com/events/past",
    siteName: "Meet Me at the Fair",
    type: "website",
  },
};

interface SearchParams {
  page?: string;
  state?: string;
  category?: string;
}

async function getPastEvents(searchParams: SearchParams) {
  const page = parseInt(searchParams.page || "1");
  const limit = 30;
  const offset = (page - 1) * limit;

  const db = getCloudflareDb();

  const conditions = [isPublicEventStatus(), lt(events.endDate, new Date())];

  if (searchParams.state) {
    conditions.push(eq(venues.state, searchParams.state) as ReturnType<typeof eq>);
  }

  if (searchParams.category) {
    const categoryPattern = `%${searchParams.category}%`;
    conditions.push(sql`${events.categories} LIKE ${categoryPattern}` as ReturnType<typeof eq>);
  }

  const [results, totalResult] = await Promise.all([
    db
      .select()
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(and(...conditions))
      .orderBy(desc(events.endDate))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: count() })
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(and(...conditions)),
  ]);

  const total = totalResult[0]?.count ?? 0;

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
        .where(and(inArray(eventVendors.eventId, batch), isPublicVendorStatus()));
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

  return { events: eventsWithVendors, total, page, limit };
}

export default async function PastEventsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const { events: eventsList, total, page, limit } = await getPastEvents(params);
  const totalPages = Math.ceil(total / limit);

  const stateLabel = params.state
    ? { ME: "Maine", VT: "Vermont", NH: "New Hampshire", MA: "Massachusetts" }[params.state] ||
      params.state
    : null;

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <ItemListSchema
        name="Past Fairs & Festivals"
        description="Browse past fairs, festivals, and community events"
        items={eventsList.map((e) => ({
          name: e.name,
          url: `https://meetmeatthefair.com/events/${e.slug}`,
          image: e.imageUrl,
        }))}
        totalCount={total}
        asCollectionPage
        pageUrl="https://meetmeatthefair.com/events/past"
      />
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Events", url: "https://meetmeatthefair.com/events" },
          { name: "Past Events", url: "https://meetmeatthefair.com/events/past" },
        ]}
      />

      <div className="mb-8">
        <nav className="text-sm text-gray-500 mb-4">
          <Link href="/" className="hover:text-navy">
            Home
          </Link>
          <span className="mx-2">/</span>
          <Link href="/events" className="hover:text-navy">
            Events
          </Link>
          <span className="mx-2">/</span>
          <span className="text-gray-900">Past Events</span>
        </nav>
        <h1 className="text-3xl font-bold text-gray-900">
          Past Events{stateLabel ? ` in ${stateLabel}` : ""}
        </h1>
        <p className="mt-2 text-gray-600">
          Browse fairs, festivals, and community events from previous seasons.{" "}
          <Link href="/events" className="text-royal hover:text-navy font-medium">
            View upcoming events &rarr;
          </Link>
        </p>
      </div>

      <EventsView
        events={eventsList}
        view="cards"
        emptyMessage="No past events found matching your filters."
        currentPage={page}
        totalPages={totalPages}
        searchParams={params as Record<string, string>}
        total={total}
        basePath="/events/past"
      />
    </div>
  );
}
