import Link from "next/link";
import type { Metadata } from "next";
import { MapPin } from "lucide-react";
import { EventsView } from "@/components/events/events-view";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, promoters, eventVendors, vendors } from "@/lib/db/schema";
import { eq, and, isNotNull, count, inArray, sql } from "drizzle-orm";
import { isPublicVendorStatus } from "@/lib/vendor-status";
import { isPublicEventStatus } from "@/lib/event-status";
import { upcomingEndPredicate } from "@/lib/event-dates";
import { attachEventDayDates } from "@/lib/event-days-attach";
import { eventJoinProjection } from "@/lib/db/event-join-projection";
import { ItemListSchema } from "@/components/seo/ItemListSchema";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { getStateColors } from "@/lib/state-colors";
import { STATES, STATE_BY_SLUG } from "@/lib/states";
import { countUpcomingEventsByState } from "@/lib/queries";
import { buildStateTitle, buildStateMetaDescription } from "@/lib/seo-utils";

export const STATE_MAP: Record<string, { code: string; name: string }> = {
  maine: { code: "ME", name: "Maine" },
  vermont: { code: "VT", name: "Vermont" },
  "new-hampshire": { code: "NH", name: "New Hampshire" },
  massachusetts: { code: "MA", name: "Massachusetts" },
  connecticut: { code: "CT", name: "Connecticut" },
  "rhode-island": { code: "RI", name: "Rhode Island" },
};

const STATE_DESCRIPTIONS: Record<string, string> = {
  maine:
    "Maine is home to some of New England's most beloved agricultural fairs, from the iconic Fryeburg Fair — the state's largest — to the Common Ground Country Fair celebrating organic farming. With over 25 county and community fairs, plus dozens of farmers markets and craft shows, Maine's fair season runs from spring through late fall.",
  vermont:
    "Vermont's fair tradition celebrates the state's agricultural heritage, from the Champlain Valley Fair to the famous Tunbridge World's Fair. The state's craft shows highlight Vermont's artisan community, while farmers markets in Burlington, Montpelier, and Rutland offer fresh local produce year-round.",
  "new-hampshire":
    "New Hampshire's fair circuit features events from the Lakes Region to the White Mountains. The Hopkinton State Fair and Deerfield Fair are annual highlights, while craft shows and farmers markets dot the landscape from Concord to the Seacoast region throughout the warmer months.",
  massachusetts:
    "Massachusetts hosts events ranging from the massive Eastern States Exposition (The Big E) in West Springfield to intimate Cape Cod craft fairs. County fairs, harvest festivals, and year-round farmers markets make the Bay State a hub for community events and local artisan culture.",
  connecticut:
    "Connecticut's fair tradition spans from the historic Durham Fair — one of New England's largest agricultural fairs — to beloved community events like the Goshen Fair and North Haven Fair. Craft shows in Mystic and the Litchfield Hills, plus year-round farmers markets from Hartford to Fairfield County, round out the Constitution State's calendar of fairs, festivals, and community events.",
  "rhode-island":
    "Rhode Island may be the smallest state, but its fair calendar is packed — from the Washington County Fair in Richmond, the state's largest agricultural fair, to the Rocky Hill State Fair and seaside summer festivals along the Newport and Narragansett coasts. Farmers markets in Providence, Pawtucket, and South County deliver fresh local produce, while craft fairs celebrate the Ocean State's maritime heritage.",
};

async function getStateEvents(
  stateCode: string,
  page: number,
  limit: number,
  includePast: boolean = false
) {
  const db = getCloudflareDb();
  const offset = (page - 1) * limit;

  const conditions = [isPublicEventStatus(), eq(events.stateCode, stateCode)];
  if (!includePast) {
    conditions.push(isNotNull(events.startDate));
    // A2 (Dev backlog 2026-06-05): 24h end-of-day grace per upcomingEndPredicate.
    conditions.push(upcomingEndPredicate(new Date()));
  }

  // Narrow projection — D1 100-col cap; see eventJoinProjection.
  const results = await db
    .select(eventJoinProjection)
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .leftJoin(promoters, eq(events.promoterId, promoters.id))
    .where(and(...conditions))
    .orderBy(sql`COALESCE(${events.startDate}, 9999999999) ASC`)
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

  // Cast lite projection back to schema row types — see
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
      slug: ev.slug,
      logoUrl: ev.logoUrl,
      vendorType: ev.vendorType,
    })),
  }));
  // Cohort 7 follow-up (2026-06-01) — same event_days attachment as
  // the other event-listing pages so the per-state grid shows the next
  // occurrence date in card badges.
  const eventsWithVendors = await attachEventDayDates(db, eventsBase);

  const countResult = await db
    .select({ count: count() })
    .from(events)
    .where(and(...conditions));

  return {
    events: eventsWithVendors,
    total: countResult[0]?.count || 0,
    page,
    limit,
  };
}

/**
 * Build Metadata for a state index page. Each `/events/{state}/page.tsx`
 * delegates its `generateMetadata` here so the per-state title/description
 * stays in one place. Count is live (rounded down to nearest 10 for stability
 * across the 5-min revalidate window) and matches what the page actually
 * lists (future events only, public status only).
 */
export async function getStateMetadata(stateSlug: string): Promise<Metadata> {
  const code = STATE_BY_SLUG[stateSlug];
  // Fallback to a minimal Metadata if the slug isn't recognized — the route
  // is statically defined so this branch is mostly a type-narrowing guard.
  if (!code) {
    return { title: "Fairs & Festivals | Meet Me at the Fair" };
  }
  const { name, adjective } = STATES[code];
  const db = getCloudflareDb();
  const eventCount = await countUpcomingEventsByState(db, code);
  const title = buildStateTitle(name);
  const description = buildStateMetaDescription(name, eventCount, adjective);
  const canonical = `https://meetmeatthefair.com/events/${stateSlug}`;
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      siteName: "Meet Me at the Fair",
      images: [
        {
          url: "https://meetmeatthefair.com/og-default.png",
          width: 1200,
          height: 630,
          alt: `Meet Me at the Fair — Fairs & Festivals in ${name}`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["https://meetmeatthefair.com/og-default.png"],
    },
  };
}

interface StateEventsPageProps {
  stateSlug: string;
  searchParams: { page?: string; includePast?: string };
}

export async function StateEventsPage({ stateSlug, searchParams }: StateEventsPageProps) {
  const state = STATE_MAP[stateSlug];
  if (!state) return null;

  const page = parseInt(searchParams.page || "1");
  const limit = 30;
  const includePast = searchParams.includePast === "true";
  const { events: eventsList, total } = await getStateEvents(state.code, page, limit, includePast);
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
        totalCount={total}
        positionStart={(page - 1) * limit + 1}
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
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${colors.bg}`}>
            <MapPin className={`w-5 h-5 ${colors.icon}`} />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-foreground">
              Fairs & Festivals in {state.name}
            </h1>
          </div>
        </div>
        <p className="mt-2 text-muted-foreground">
          Browse {total} {includePast ? "" : "upcoming "}fairs, festivals, craft shows, and markets
          across {state.name}.
        </p>
        <nav className="mt-4 text-sm text-muted-foreground" aria-label="Breadcrumb">
          <Link href="/" className="hover:text-navy">
            Home
          </Link>
          <span className="mx-2">/</span>
          <Link href="/events" className="hover:text-navy">
            Events
          </Link>
          <span className="mx-2">/</span>
          <span className="text-foreground">{state.name}</span>
        </nav>
      </div>

      {/* Include past events toggle */}
      <form className="mb-6 flex items-center gap-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="includePast"
            value="true"
            defaultChecked={includePast}
            className="rounded border-border text-royal focus:ring-royal"
          />
          <span className="text-sm text-foreground">Include past events</span>
        </label>
        <button type="submit" className="text-sm text-royal hover:text-navy font-medium">
          Apply
        </button>
      </form>

      {/* Event listing */}
      {eventsList.length > 0 ? (
        <EventsView
          events={eventsList}
          view="cards"
          emptyMessage={`No upcoming events found in ${state.name}. Check back soon!`}
          currentPage={page}
          totalPages={totalPages}
          searchParams={{
            ...(searchParams.page ? { page: searchParams.page } : {}),
            ...(includePast ? { includePast: "true" } : {}),
          }}
          total={total}
          basePath={`/events/${stateSlug}`}
        />
      ) : (
        <div className="text-center py-12">
          <MapPin className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground text-lg">No upcoming events found in {state.name}.</p>
          <p className="text-muted-foreground mt-2">
            Check back soon or{" "}
            <Link href="/events" className="text-royal hover:text-navy font-medium">
              browse all events
            </Link>
            .
          </p>
        </div>
      )}

      <div className="mt-8 bg-muted rounded-lg p-6 text-center border border-border">
        <h3 className="text-lg font-semibold text-foreground mb-2">
          Looking for past events in {state.name}?
        </h3>
        <p className="text-sm text-muted-foreground mb-3">
          Browse fairs and festivals from previous seasons across {state.name}.
        </p>
        <Link
          href={`/events/past?state=${state.code}`}
          className="inline-flex items-center gap-2 px-4 py-2 bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/90 transition-colors text-sm font-medium"
        >
          Browse past events in {state.name} &rarr;
        </Link>
      </div>

      {/* SEO content */}
      {total > 0 && (
        <div className="mt-12 prose prose-gray max-w-none">
          <h2>About Fairs in {state.name}</h2>
          <p>
            {STATE_DESCRIPTIONS[stateSlug] ||
              `${state.name} hosts a vibrant calendar of fairs, festivals, farmers markets, and craft shows throughout the year. From county fairs celebrating local agriculture to artisan craft fairs showcasing handmade goods, there's always something happening.`}{" "}
            Browse our listings to find events near you, check dates and venues, and connect with
            vendors.
          </p>
        </div>
      )}
    </div>
  );
}
