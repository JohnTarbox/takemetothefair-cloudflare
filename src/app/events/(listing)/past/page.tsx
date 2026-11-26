import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { parseListingPage } from "@/lib/listing-page-param";
import { EventsView } from "@/components/events/events-view";
import { getCloudflareDb, getCloudflareRateLimitKv } from "@/lib/cloudflare";
import { loadPastEventsCached } from "@/lib/events/listing-family-cache";
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

/**
 * OPE-1668 — a page reads only its own rows by id from ONE cached ordered-id
 * index per (state, category) (src/lib/events/listing-family-cache.ts); the
 * total is the index length. The scan + count(*) run once per key per TTL.
 */
async function getPastEvents(searchParams: SearchParams, page: number) {
  const limit = 30;
  const offset = (page - 1) * limit;
  const { events: eventsWithVendors, total } = await loadPastEventsCached(
    getCloudflareDb(),
    getCloudflareRateLimitKv(),
    { state: searchParams.state, category: searchParams.category },
    { limit, offset }
  );
  return { events: eventsWithVendors, total, page, limit };
}

export const dynamic = "force-dynamic";

export default async function PastEventsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  // OPE-1573 — a malformed ?page= 404s here, before any D1 query (see helper).
  const requestedPage = parseListingPage(params.page);
  if (requestedPage === null) notFound();
  const { events: eventsList, total, page, limit } = await getPastEvents(params, requestedPage);
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
