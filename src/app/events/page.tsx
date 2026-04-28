import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { Search, Filter, Store, Heart } from "lucide-react";
import { EventsView } from "@/components/events/events-view";
import { getCloudflareDb } from "@/lib/cloudflare";
import {
  events,
  venues,
  promoters,
  eventVendors,
  vendors,
  userFavorites,
  eventDays,
} from "@/lib/db/schema";
import {
  eq,
  and,
  gte,
  or,
  count,
  inArray,
  sql,
  like,
  notLike,
  isNull,
  isNotNull,
  asc,
  desc,
} from "drizzle-orm";
import { isPublicVendorStatus } from "@/lib/vendor-status";
import { isPublicEventStatus } from "@/lib/event-status";
import { auth } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { ItemListSchema } from "@/components/seo/ItemListSchema";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { MobileFilterDrawer } from "@/components/ui/mobile-filter-drawer";

export const runtime = "edge";
export const revalidate = 300; // Cache for 5 minutes

export const metadata: Metadata = {
  title: "Upcoming Fairs & Festivals | Meet Me at the Fair",
  description:
    "Browse upcoming fairs, festivals, and community events. Filter by category, state, and more.",
  alternates: { canonical: "https://meetmeatthefair.com/events" },
  openGraph: {
    title: "Upcoming Fairs & Festivals | Meet Me at the Fair",
    description:
      "Browse upcoming fairs, festivals, and community events. Filter by category, state, and more.",
    url: "https://meetmeatthefair.com/events",
    siteName: "Meet Me at the Fair",
    type: "website",
    images: [
      {
        url: "https://meetmeatthefair.com/og-default.png",
        width: 1200,
        height: 630,
        alt: "Meet Me at the Fair — Discover Local Fairs, Festivals & Events",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Upcoming Fairs & Festivals | Meet Me at the Fair",
    description:
      "Browse upcoming fairs, festivals, and community events. Filter by category, state, and more.",
    images: ["https://meetmeatthefair.com/og-default.png"],
  },
};

interface SearchParams {
  query?: string;
  category?: string;
  state?: string;
  featured?: string;
  commercialVendors?: string;
  excludeFarmersMarkets?: string;
  includePast?: string;
  includeTBD?: string;
  myEvents?: string;
  favorites?: string;
  indoorOutdoor?: string;
  scale?: string;
  page?: string;
  view?: string;
  sort?: string;
}

type ViewMode = "cards" | "table" | "calendar";

function parseView(view?: string): ViewMode {
  if (view === "table" || view === "calendar") return view;
  return "cards";
}

// Get the vendor ID and coordinates for a user
async function getVendorForUser(
  userId: string
): Promise<{ id: string; latitude: number | null; longitude: number | null } | null> {
  try {
    const db = getCloudflareDb();
    const [vendor] = await db
      .select({ id: vendors.id, latitude: vendors.latitude, longitude: vendors.longitude })
      .from(vendors)
      .where(eq(vendors.userId, userId))
      .limit(1);
    return vendor || null;
  } catch (error) {
    console.error("Failed to fetch vendor for user", { error, userId });
    return null;
  }
}

async function getEvents(
  searchParams: SearchParams,
  vendorId?: string,
  favoriteUserId?: string,
  includeVendorDays?: boolean
) {
  const viewMode = parseView(searchParams.view);
  const isCalendarView = viewMode === "calendar";
  const page = parseInt(searchParams.page || "1");
  const limit = 30;
  const offset = (page - 1) * limit;
  const sort = searchParams.sort || "date-asc";

  const db = getCloudflareDb();

  try {
    // Build conditions
    const conditions = [isPublicEventStatus()];

    // Date filtering logic:
    // - includePast=true: show all events (past, future, and TBD)
    // - default: show future events AND events with null dates (TBD)
    if (searchParams.includePast !== "true") {
      // Show future events OR events with null end dates (TBD)
      conditions.push(or(gte(events.endDate, new Date()), isNull(events.endDate))!);
    }

    if (searchParams.query) {
      const query = searchParams.query.toLowerCase().trim();
      const searchTerm = `%${query}%`;

      // Build search conditions
      const searchConditions = [
        // Exact substring match (case-insensitive)
        sql`LOWER(${events.name}) LIKE ${searchTerm}`,
        sql`LOWER(${events.description}) LIKE ${searchTerm}`,
      ];

      // Add fuzzy matching using trigrams for typo tolerance
      // For words > 4 chars, generate overlapping 3-char patterns
      // "Choclate" -> %cho%, %hoc%, %ocl%, %cla%, %lat%, %ate%
      // This will match "Chocolate" which contains most of these
      if (query.length >= 4) {
        const trigrams: string[] = [];
        for (let i = 0; i <= query.length - 3; i++) {
          trigrams.push(query.substring(i, i + 3));
        }

        // Require at least 60% of trigrams to match (allows for typos)
        const minMatches = Math.max(2, Math.floor(trigrams.length * 0.6));

        // Build a condition that counts matching trigrams
        const trigramConditions = trigrams.map(
          (t) => sql`(CASE WHEN LOWER(${events.name}) LIKE ${"%" + t + "%"} THEN 1 ELSE 0 END)`
        );

        if (trigramConditions.length > 0) {
          searchConditions.push(sql`(${sql.join(trigramConditions, sql` + `)}) >= ${minMatches}`);
        }
      }

      conditions.push(or(...searchConditions)!);
    }

    if (searchParams.category) {
      conditions.push(like(events.categories, `%${searchParams.category}%`));
    }

    if (searchParams.featured === "true") {
      conditions.push(eq(events.featured, true));
    }

    if (searchParams.commercialVendors === "true") {
      conditions.push(eq(events.commercialVendorsAllowed, true));
    }

    if (searchParams.excludeFarmersMarkets === "true") {
      // categories defaults to "[]" but historical rows may be NULL —
      // SQL NULL NOT LIKE '%x%' is NULL (filters them out), so OR isNull
      // to keep uncategorized events visible.
      conditions.push(
        or(notLike(events.categories, "%Farmers Market%"), isNull(events.categories))!
      );
    }

    if (searchParams.indoorOutdoor) {
      conditions.push(eq(events.indoorOutdoor, searchParams.indoorOutdoor));
    }

    if (searchParams.scale) {
      conditions.push(eq(events.eventScale, searchParams.scale));
    }

    // Filter by vendor's events using subquery (avoids D1 bind parameter limit)
    if (searchParams.myEvents === "true" && vendorId) {
      conditions.push(
        sql`${events.id} IN (SELECT ${eventVendors.eventId} FROM ${eventVendors} WHERE ${eventVendors.vendorId} = ${vendorId})`
      );
    } else if (searchParams.myEvents === "true" && !vendorId) {
      // Vendor has no events, return empty
      return { events: [], total: 0, page, limit };
    }

    // Filter by favorites using subquery (avoids D1 bind parameter limit)
    if (searchParams.favorites === "true" && favoriteUserId) {
      conditions.push(
        sql`${events.id} IN (SELECT ${userFavorites.favoritableId} FROM ${userFavorites} WHERE ${userFavorites.userId} = ${favoriteUserId} AND ${userFavorites.favoritableType} = 'EVENT')`
      );
    } else if (searchParams.favorites === "true" && !favoriteUserId) {
      // User has no favorites, return empty
      return { events: [], total: 0, page, limit };
    }

    // Get events with joins
    // Build separate queries for calendar (no pagination) vs cards/table (paginated)
    const stateConditions = searchParams.state
      ? [...conditions, eq(events.stateCode, searchParams.state)]
      : conditions;

    const orderByMap: Record<string, ReturnType<typeof asc>> = {
      "date-asc": asc(events.startDate),
      "date-desc": desc(events.startDate),
      "name-asc": asc(events.name),
      "name-desc": desc(events.name),
      popular: desc(events.viewCount),
    };
    const orderBy = orderByMap[sort] || asc(events.startDate);

    let query;
    if (isCalendarView) {
      query = db
        .select()
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .leftJoin(promoters, eq(events.promoterId, promoters.id))
        .where(and(...stateConditions))
        .orderBy(orderBy);
    } else {
      query = db
        .select()
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .leftJoin(promoters, eq(events.promoterId, promoters.id))
        .where(and(...stateConditions))
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset);
    }

    const results = await query;

    // Get all event IDs from results
    const eventIds = results.map((r) => r.events.id);

    // Single query: Fetch all vendors for all events at once
    const allEventVendors: {
      eventId: string;
      vendorId: string;
      businessName: string;
      slug: string;
      logoUrl: string | null;
      vendorType: string | null;
    }[] = [];

    if (eventIds.length > 0) {
      // D1 has a limit on SQL bind variables, so batch large arrays
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

    // Group vendors by event ID in memory
    const vendorsByEvent = new Map<string, typeof allEventVendors>();
    for (const ev of allEventVendors) {
      const existing = vendorsByEvent.get(ev.eventId) || [];
      existing.push(ev);
      vendorsByEvent.set(ev.eventId, existing);
    }

    // For calendar view, fetch eventDays for discontinuous events
    const daysByEvent = new Map<string, string[]>();
    if (isCalendarView) {
      const discontinuousIds = results
        .filter((r) => r.events.discontinuousDates)
        .map((r) => r.events.id);

      if (discontinuousIds.length > 0) {
        const BATCH_SIZE = 50;
        for (let i = 0; i < discontinuousIds.length; i += BATCH_SIZE) {
          const batch = discontinuousIds.slice(i, i + BATCH_SIZE);
          const dayConditions = [inArray(eventDays.eventId, batch)];
          if (!includeVendorDays) {
            dayConditions.push(eq(eventDays.vendorOnly, false));
          }
          const dayResults = await db
            .select({ eventId: eventDays.eventId, date: eventDays.date })
            .from(eventDays)
            .where(and(...dayConditions));
          for (const row of dayResults) {
            const existing = daysByEvent.get(row.eventId) || [];
            existing.push(row.date);
            daysByEvent.set(row.eventId, existing);
          }
        }
      }
    }

    // Combine events with their vendors
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
      // Include specific dates for discontinuous events (calendar view)
      ...(r.events.discontinuousDates && daysByEvent.has(r.events.id)
        ? { eventDayDates: daysByEvent.get(r.events.id) }
        : {}),
    }));

    // Count total (state filter now lives on events.state_code, so no venue join needed)
    const countResult = await db
      .select({ count: count() })
      .from(events)
      .where(and(...stateConditions));

    return {
      events: eventsWithVendors,
      total: countResult[0]?.count || 0,
      page,
      limit,
    };
  } catch (e) {
    await logError(db, {
      message: "Error fetching events",
      error: e,
      source: "app/events/page.tsx:getEvents",
      context: { isCalendarView, page, limit },
    });
    return { events: [], total: 0, page: 1, limit };
  }
}

async function getCategories() {
  try {
    const db = getCloudflareDb();
    const results = await db
      .select({ categories: events.categories })
      .from(events)
      .where(isPublicEventStatus());

    const categories = new Set<string>();
    results.forEach((e) => {
      try {
        const cats = JSON.parse(e.categories || "[]");
        cats.forEach((c: string) => categories.add(c));
      } catch {}
    });
    return Array.from(categories).sort();
  } catch (error) {
    console.error("Failed to fetch event categories", { error });
    return [];
  }
}

async function getStates() {
  try {
    const db = getCloudflareDb();
    // Union active-venue states with any event state_code so statewide-only
    // events (venue_id NULL) still surface their state in nav/filters.
    const [venueStates, eventStates] = await Promise.all([
      db.selectDistinct({ state: venues.state }).from(venues).where(eq(venues.status, "ACTIVE")),
      db
        .selectDistinct({ state: events.stateCode })
        .from(events)
        .where(and(isPublicEventStatus(), isNotNull(events.stateCode))),
    ]);

    const all = new Set<string>();
    for (const { state } of venueStates) if (state) all.add(state);
    for (const { state } of eventStates) if (state) all.add(state);
    return Array.from(all).sort();
  } catch (error) {
    console.error("Failed to fetch venue states", { error });
    return [];
  }
}

function EventsFilter({
  categories,
  states,
  searchParams,
  isVendor = false,
  isLoggedIn = false,
}: {
  categories: string[];
  states: string[];
  searchParams: SearchParams;
  isVendor?: boolean;
  isLoggedIn?: boolean;
}) {
  const viewMode = parseView(searchParams.view);
  const clearParams = new URLSearchParams();
  if (viewMode !== "cards") {
    clearParams.set("view", viewMode);
  }
  const clearHref = `/events${clearParams.toString() ? `?${clearParams.toString()}` : ""}`;

  return (
    <form className="bg-white p-4 rounded-lg border border-gray-200 space-y-4">
      {searchParams.view && <input type="hidden" name="view" value={searchParams.view} />}

      {/* Vendor-only filter */}
      {isVendor && (
        <div className="bg-purple-50 border border-purple-200 rounded-lg p-3">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="myEvents"
              value="true"
              defaultChecked={searchParams.myEvents === "true"}
              className="rounded border-purple-300 text-purple-600 focus:ring-purple-500"
            />
            <span className="text-sm font-medium text-purple-700 flex items-center gap-1">
              <Store className="w-4 h-4" />
              My participating events
            </span>
          </label>
          <p className="text-xs text-purple-600 mt-1 ml-6">
            Show only events where you are a vendor
          </p>
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Search</label>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            name="query"
            defaultValue={searchParams.query}
            placeholder="Search events..."
            className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
        <select
          name="category"
          defaultValue={searchParams.category}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
        >
          <option value="">All Categories</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
        <select
          name="state"
          defaultValue={searchParams.state}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
        >
          <option value="">All States</option>
          {states.map((state) => (
            <option key={state} value={state}>
              {state}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Indoor/Outdoor</label>
        <select
          name="indoorOutdoor"
          defaultValue={searchParams.indoorOutdoor}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
        >
          <option value="">Any</option>
          <option value="INDOOR">Indoor</option>
          <option value="OUTDOOR">Outdoor</option>
          <option value="MIXED">Mixed</option>
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Event Scale</label>
        <select
          name="scale"
          defaultValue={searchParams.scale}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
        >
          <option value="">Any size</option>
          <option value="SMALL">Small</option>
          <option value="MEDIUM">Medium</option>
          <option value="LARGE">Large</option>
          <option value="MAJOR">Major</option>
        </select>
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          name="featured"
          value="true"
          defaultChecked={searchParams.featured === "true"}
          className="rounded border-gray-300 text-royal focus:ring-royal"
        />
        <span className="text-sm text-gray-700">Featured only</span>
      </label>

      <fieldset className="border-t border-gray-200 pt-3">
        <legend className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
          Vendor & event type
        </legend>

        <label className="flex items-start gap-2 mb-2">
          <input
            type="checkbox"
            name="commercialVendors"
            value="true"
            defaultChecked={searchParams.commercialVendors === "true"}
            className="mt-0.5 rounded border-gray-300 text-royal focus:ring-royal"
          />
          <span className="text-sm text-gray-700">
            Only shows that allow commercial vendors
            <span className="block text-xs text-gray-500">
              Hides events whose listing indicates only craft, food, or farm vendors.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            name="excludeFarmersMarkets"
            value="true"
            defaultChecked={searchParams.excludeFarmersMarkets === "true"}
            className="mt-0.5 rounded border-gray-300 text-royal focus:ring-royal"
          />
          <span className="text-sm text-gray-700">Hide farmers markets</span>
        </label>
      </fieldset>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          name="includePast"
          value="true"
          defaultChecked={searchParams.includePast === "true"}
          className="rounded border-gray-300 text-royal focus:ring-royal"
        />
        <span className="text-sm text-gray-700">Include past events</span>
      </label>

      {isLoggedIn && (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="favorites"
            value="true"
            defaultChecked={searchParams.favorites === "true"}
            className="rounded border-gray-300 text-pink-600 focus:ring-pink-500"
          />
          <Heart className="w-4 h-4 text-pink-500" />
          <span className="text-sm text-gray-700">My Favorites</span>
        </label>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          className="flex-1 bg-royal text-white py-2 px-4 rounded-lg hover:bg-navy transition-colors flex items-center justify-center gap-2"
        >
          <Filter className="w-4 h-4" />
          Apply Filters
        </button>
        <a
          href={clearHref}
          className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
        >
          Clear
        </a>
      </div>
    </form>
  );
}

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

  // Get session to check if user is a vendor
  const session = await auth();
  const isVendor = session?.user?.role === "VENDOR";
  const isLoggedIn = !!session?.user?.id;

  // Get vendor info (ID + coordinates) if the user is a vendor
  let vendorId: string | undefined;
  let vendorCoords: { lat: number; lng: number } | null = null;
  if (isVendor) {
    const vendor = await getVendorForUser(session.user.id);
    if (vendor) {
      if (params.myEvents === "true") {
        vendorId = vendor.id;
      }
      if (vendor.latitude && vendor.longitude) {
        vendorCoords = { lat: vendor.latitude, lng: vendor.longitude };
      }
    }
  }

  // Pass userId for favorites subquery (avoids D1 bind parameter limit)
  const favoriteUserId = isLoggedIn && params.favorites === "true" ? session.user.id : undefined;

  const viewMode = parseView(params.view);
  const [{ events: eventsList, total, page, limit }, categories, states] = await Promise.all([
    getEvents(params, vendorId, favoriteUserId, isVendor || session?.user?.role === "ADMIN"),
    getCategories(),
    getStates(),
  ]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 print:max-w-none print:px-0 print:py-0">
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Events", url: "https://meetmeatthefair.com/events" },
        ]}
      />
      <ItemListSchema
        name="Upcoming Fairs & Festivals"
        description="Browse upcoming fairs, festivals, and community events"
        items={eventsList.map((e) => ({
          name: e.name,
          url: `https://meetmeatthefair.com/events/${e.slug}`,
          image: e.imageUrl,
        }))}
        totalCount={total}
        asCollectionPage
        pageUrl="https://meetmeatthefair.com/events"
      />
      <div className="mb-8 print:hidden">
        <h1 className="text-3xl font-bold text-gray-900">Browse Events</h1>
        <p className="mt-2 text-gray-600">
          Discover upcoming fairs, festivals, and community events
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8 print:block">
        <aside className="lg:col-span-1 print:hidden">
          <MobileFilterDrawer>
            <Suspense fallback={<div className="animate-pulse bg-gray-200 h-64 rounded-lg" />}>
              <EventsFilter
                categories={categories}
                states={states}
                searchParams={params}
                isVendor={isVendor}
                isLoggedIn={isLoggedIn}
              />
            </Suspense>
          </MobileFilterDrawer>
        </aside>

        <main className="lg:col-span-3">
          <EventsView
            events={eventsList}
            view={viewMode}
            emptyMessage={
              params.myEvents === "true"
                ? "You are not participating in any events yet. Apply to events to see them here."
                : "No events match your filters. Try adjusting your search."
            }
            currentPage={page}
            totalPages={totalPages}
            searchParams={params as Record<string, string>}
            total={total}
            myEvents={params.myEvents === "true"}
            vendorCoords={vendorCoords}
          />
          <div className="mt-8 bg-gray-50 rounded-lg p-6 text-center border border-gray-200 print:hidden">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Looking for past events?</h3>
            <p className="text-sm text-gray-600 mb-3">
              Browse fairs and festivals from previous seasons, including event details and vendor
              information.
            </p>
            <Link
              href="/events/past"
              className="inline-flex items-center gap-2 px-4 py-2 bg-royal text-white rounded-lg hover:bg-navy transition-colors text-sm font-medium"
            >
              Browse past events &rarr;
            </Link>
          </div>
        </main>
      </div>
    </div>
  );
}
