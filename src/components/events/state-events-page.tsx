import Link from "next/link";
import { MapPin } from "lucide-react";
import { EventsView } from "@/components/events/events-view";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, promoters, eventVendors, vendors } from "@/lib/db/schema";
import { eq, and, gte, or, isNull, count, inArray } from "drizzle-orm";
import { isPublicVendorStatus } from "@/lib/vendor-status";
import { isPublicEventStatus } from "@/lib/event-status";
import { ItemListSchema } from "@/components/seo/ItemListSchema";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { getStateColors } from "@/lib/state-colors";

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
    conditions.push(or(gte(events.endDate, new Date()), isNull(events.endDate))!);
  }

  const results = await db
    .select()
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
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
            <h1 className="text-3xl font-bold text-gray-900">Fairs & Festivals in {state.name}</h1>
          </div>
        </div>
        <p className="mt-2 text-gray-600">
          Browse {total} {includePast ? "" : "upcoming "}fairs, festivals, craft shows, and markets
          across {state.name}.
        </p>
        <nav className="mt-4 text-sm text-gray-500" aria-label="Breadcrumb">
          <Link href="/" className="hover:text-navy">
            Home
          </Link>
          <span className="mx-2">/</span>
          <Link href="/events" className="hover:text-navy">
            Events
          </Link>
          <span className="mx-2">/</span>
          <span className="text-gray-900">{state.name}</span>
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
            className="rounded border-gray-300 text-royal focus:ring-royal"
          />
          <span className="text-sm text-gray-700">Include past events</span>
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
          <MapPin className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-600 text-lg">No upcoming events found in {state.name}.</p>
          <p className="text-gray-500 mt-2">
            Check back soon or{" "}
            <Link href="/events" className="text-royal hover:text-navy font-medium">
              browse all events
            </Link>
            .
          </p>
        </div>
      )}

      <div className="mt-8 bg-gray-50 rounded-lg p-6 text-center border border-gray-200">
        <h3 className="text-lg font-semibold text-gray-900 mb-2">
          Looking for past events in {state.name}?
        </h3>
        <p className="text-sm text-gray-600 mb-3">
          Browse fairs and festivals from previous seasons across {state.name}.
        </p>
        <Link
          href={`/events/past?state=${state.code}`}
          className="inline-flex items-center gap-2 px-4 py-2 bg-royal text-white rounded-lg hover:bg-navy transition-colors text-sm font-medium"
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
