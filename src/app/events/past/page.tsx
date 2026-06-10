import type { Metadata } from "next";
import Link from "next/link";
import { EventsView } from "@/components/events/events-view";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, promoters, eventVendors, vendors } from "@/lib/db/schema";
import { eq, and, lt, count, inArray, desc, sql } from "drizzle-orm";
import { isPublicVendorStatus } from "@/lib/vendor-status";
import { isPublicEventStatus } from "@/lib/event-status";
import { attachEventDayDates } from "@/lib/event-days-attach";
import { eventJoinProjection } from "@/lib/db/event-join-projection";
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

  // Narrow projection — D1's 100-col result-row cap; see
  // eventJoinProjection. The count query stays unchanged: it only
  // selects COUNT(*) so it doesn't trip the column cap.
  const [results, totalResult] = await Promise.all([
    db
      .select(eventJoinProjection)
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
    displayName: string | null;
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
          // EH2.1 — brand display_name override on past-events vendor tiles.
          displayName: vendors.displayName,
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

  // Cast the lite projection back to schema row types so EventsView's
  // `Venue | null` / `Promoter | null` props compile. See
  // eventJoinProjection for the audit + maintenance contract.
  type FullVenue = typeof venues.$inferSelect;
  type FullPromoter = typeof promoters.$inferSelect;
  // EventRow derived from results so projection changes flow through.
  type EventRow = (typeof results)[number];
  const eventsBase = results.map((r: EventRow) => ({
    ...r.events,
    venue: r.venue as FullVenue | null,
    promoter: r.promoter as FullPromoter | null,
    vendors: (vendorsByEvent.get(r.events.id) || []).map((ev) => ({
      id: ev.vendorId,
      businessName: ev.businessName,
      displayName: ev.displayName,
      slug: ev.slug,
      logoUrl: ev.logoUrl,
      vendorType: ev.vendorType,
    })),
  }));
  // Cohort 7 follow-up (2026-06-01) — past-events listings show the
  // last-occurrence date instead of the series start when event_days
  // are populated. Same helper as the upcoming-events sweep.
  const eventsWithVendors = await attachEventDayDates(db, eventsBase);

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
        positionStart={(page - 1) * limit + 1}
        order="descending"
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
        <nav className="text-sm text-muted-foreground mb-4">
          <Link href="/" className="hover:text-navy">
            Home
          </Link>
          <span className="mx-2">/</span>
          <Link href="/events" className="hover:text-navy">
            Events
          </Link>
          <span className="mx-2">/</span>
          <span className="text-foreground">Past Events</span>
        </nav>
        <h1 className="text-3xl font-bold text-foreground">
          Past Events{stateLabel ? ` in ${stateLabel}` : ""}
        </h1>
        <p className="mt-2 text-muted-foreground">
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
