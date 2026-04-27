import type { Metadata } from "next";
import Link from "next/link";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues } from "@/lib/db/schema";
import { eq, asc } from "drizzle-orm";
import { isPublicEventStatus } from "@/lib/event-status";
import { ItemListSchema } from "@/components/seo/ItemListSchema";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "All Upcoming Events | Meet Me at the Fair",
  description:
    "Complete directory of all upcoming fairs, festivals, craft shows, and markets in New England.",
  alternates: { canonical: "https://meetmeatthefair.com/events/all" },
  openGraph: {
    title: "All Upcoming Events | Meet Me at the Fair",
    description:
      "Complete directory of all upcoming fairs, festivals, craft shows, and markets in New England.",
    url: "https://meetmeatthefair.com/events/all",
  },
};

const STATE_NAMES: Record<string, string> = {
  ME: "Maine",
  VT: "Vermont",
  NH: "New Hampshire",
  MA: "Massachusetts",
  CT: "Connecticut",
  RI: "Rhode Island",
};

export default async function AllEventsPage() {
  const db = getCloudflareDb();

  const results = await db
    .select({
      name: events.name,
      slug: events.slug,
      imageUrl: events.imageUrl,
      startDate: events.startDate,
      stateCode: events.stateCode,
      venueState: venues.state,
    })
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .where(isPublicEventStatus())
    .orderBy(asc(events.name));

  // Separate upcoming from past
  const now = new Date();
  const upcomingEvents = results.filter((e) => !e.startDate || new Date(e.startDate) >= now);

  // Group by state — prefer events.state_code (authoritative post-migration);
  // fall back to venues.state for any event whose backfill hasn't landed yet.
  const byState = new Map<string, typeof results>();
  for (const event of upcomingEvents) {
    const key = event.stateCode || event.venueState || "Other";
    if (!byState.has(key)) byState.set(key, []);
    byState.get(key)!.push(event);
  }

  // Sort states alphabetically, "Other" last
  const sortedStates = [...byState.keys()].sort((a, b) => {
    if (a === "Other") return 1;
    if (b === "Other") return -1;
    return (STATE_NAMES[a] || a).localeCompare(STATE_NAMES[b] || b);
  });

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Events", url: "https://meetmeatthefair.com/events" },
          { name: "All Events", url: "https://meetmeatthefair.com/events/all" },
        ]}
      />
      <ItemListSchema
        name="All Upcoming Fairs & Festivals"
        description="Complete directory of all upcoming fairs, festivals, craft shows, and markets in New England"
        items={upcomingEvents.map((e) => ({
          name: e.name,
          url: `https://meetmeatthefair.com/events/${e.slug}`,
          image: e.imageUrl,
        }))}
        totalCount={upcomingEvents.length}
        asCollectionPage
        pageUrl="https://meetmeatthefair.com/events/all"
      />

      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">All Upcoming Events</h1>
        <p className="mt-2 text-gray-600">
          Complete directory of {upcomingEvents.length} upcoming fairs, festivals, and events in New
          England.
        </p>
      </div>

      {sortedStates.map((stateCode) => {
        const stateEvents = byState.get(stateCode)!;
        const stateName = STATE_NAMES[stateCode] || "Other Locations";
        return (
          <section key={stateCode} className="mb-8">
            <h2 className="text-xl font-semibold text-gray-800 border-b border-gray-200 pb-2 mb-3">
              {stateName} ({stateEvents.length})
            </h2>
            <ul className="columns-1 sm:columns-2 lg:columns-3 gap-x-8">
              {stateEvents.map((event) => (
                <li key={event.slug} className="break-inside-avoid mb-1">
                  <Link
                    href={`/events/${event.slug}`}
                    className="text-royal hover:text-blue-800 hover:underline text-sm"
                  >
                    {event.name}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <div className="mt-8 pt-6 border-t border-gray-200 text-sm text-gray-500">
        <Link href="/events" className="text-royal hover:underline">
          Browse events with filters
        </Link>
        {" · "}
        <Link href="/events/past" className="text-royal hover:underline">
          View past events
        </Link>
      </div>
    </div>
  );
}
