import { Suspense } from "react";
import { Search, Filter, Store, Heart } from "lucide-react";
import { EventsView } from "@/components/events/events-view";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, promoters, eventVendors, vendors, userFavorites } from "@/lib/db/schema";
import { eq, and, gte, or, count, inArray, sql, like, isNull } from "drizzle-orm";
import { auth } from "@/lib/auth";

export const runtime = "edge";
export const revalidate = 60; // Cache for 1 minute


interface SearchParams {
  query?: string;
  category?: string;
  state?: string;
  featured?: string;
  commercialVendors?: string;
  includePast?: string;
  includeTBD?: string;
  myEvents?: string;
  favorites?: string;
  page?: string;
  view?: string;
}

type ViewMode = "cards" | "table" | "calendar";

function parseView(view?: string): ViewMode {
  if (view === "table" || view === "calendar") return view;
  return "cards";
}

// Get favorite IDs for a user
async function getUserFavoriteIds(userId: string, type: "EVENT" | "VENUE" | "VENDOR"): Promise<string[]> {
  try {
    const db = getCloudflareDb();
    const favorites = await db
      .select({ favoritableId: userFavorites.favoritableId })
      .from(userFavorites)
      .where(and(eq(userFavorites.userId, userId), eq(userFavorites.favoritableType, type)));
    return favorites.map((f) => f.favoritableId);
  } catch {
    return [];
  }
}

// Get the vendor ID for a user
async function getVendorIdForUser(userId: string): Promise<string | null> {
  try {
    const db = getCloudflareDb();
    const [vendor] = await db
      .select({ id: vendors.id })
      .from(vendors)
      .where(eq(vendors.userId, userId))
      .limit(1);
    return vendor?.id || null;
  } catch {
    return null;
  }
}

// Get event IDs where a vendor is participating
async function getVendorEventIds(vendorId: string): Promise<string[]> {
  try {
    const db = getCloudflareDb();
    const results = await db
      .select({ eventId: eventVendors.eventId })
      .from(eventVendors)
      .where(eq(eventVendors.vendorId, vendorId));
    return results.map(r => r.eventId);
  } catch {
    return [];
  }
}

async function getEvents(searchParams: SearchParams, vendorEventIds?: string[], favoriteIds?: string[]) {
  const viewMode = parseView(searchParams.view);
  const isCalendarView = viewMode === "calendar";
  const page = parseInt(searchParams.page || "1");
  const limit = 12;
  const offset = (page - 1) * limit;

  try {
    const db = getCloudflareDb();

    // Build conditions
    const conditions = [
      eq(events.status, "APPROVED"),
    ];

    // Date filtering logic:
    // - includePast=true: show all events (past, future, and TBD)
    // - includeTBD=true: show future events AND events with null dates
    // - default: show only future events with confirmed dates
    if (searchParams.includePast !== "true") {
      if (searchParams.includeTBD === "true") {
        // Show future events OR events with null end dates (TBD)
        conditions.push(
          or(
            gte(events.endDate, new Date()),
            isNull(events.endDate)
          )!
        );
      } else {
        // Show only future events with confirmed dates
        conditions.push(gte(events.endDate, new Date()));
      }
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
        const trigramConditions = trigrams.map(t =>
          sql`(CASE WHEN LOWER(${events.name}) LIKE ${'%' + t + '%'} THEN 1 ELSE 0 END)`
        );

        if (trigramConditions.length > 0) {
          searchConditions.push(
            sql`(${sql.join(trigramConditions, sql` + `)}) >= ${minMatches}`
          );
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

    // Filter by vendor's events if myEvents is true
    if (searchParams.myEvents === "true" && vendorEventIds && vendorEventIds.length > 0) {
      conditions.push(inArray(events.id, vendorEventIds));
    } else if (searchParams.myEvents === "true" && (!vendorEventIds || vendorEventIds.length === 0)) {
      // Vendor has no events, return empty
      return { events: [], total: 0, page, limit };
    }

    // Filter by favorites if favorites is true
    if (searchParams.favorites === "true" && favoriteIds && favoriteIds.length > 0) {
      conditions.push(inArray(events.id, favoriteIds));
    } else if (searchParams.favorites === "true" && (!favoriteIds || favoriteIds.length === 0)) {
      // User has no favorites, return empty
      return { events: [], total: 0, page, limit };
    }

    // Get events with joins
    // Build separate queries for calendar (no pagination) vs cards/table (paginated)
    const stateConditions = searchParams.state
      ? [...conditions, eq(venues.state, searchParams.state)]
      : conditions;

    let query;
    if (isCalendarView) {
      query = db
        .select()
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .leftJoin(promoters, eq(events.promoterId, promoters.id))
        .where(and(...stateConditions))
        .orderBy(events.startDate);
    } else {
      query = db
        .select()
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .leftJoin(promoters, eq(events.promoterId, promoters.id))
        .where(and(...stateConditions))
        .orderBy(events.startDate)
        .limit(limit)
        .offset(offset);
    }

    const results = await query;

    // Get all event IDs from results
    const eventIds = results.map(r => r.events.id);

    // Single query: Fetch all vendors for all events at once
    let allEventVendors: {
      eventId: string;
      vendorId: string;
      businessName: string;
      slug: string;
      logoUrl: string | null;
      vendorType: string | null;
    }[] = [];

    if (eventIds.length > 0) {
      allEventVendors = await db
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
          and(
            inArray(eventVendors.eventId, eventIds),
            eq(eventVendors.status, "APPROVED")
          )
        );
    }

    // Group vendors by event ID in memory
    const vendorsByEvent = new Map<string, typeof allEventVendors>();
    for (const ev of allEventVendors) {
      const existing = vendorsByEvent.get(ev.eventId) || [];
      existing.push(ev);
      vendorsByEvent.set(ev.eventId, existing);
    }

    // Combine events with their vendors
    const eventsWithVendors = results.map(r => ({
      ...r.events,
      venue: r.venues,
      promoter: r.promoters,
      vendors: (vendorsByEvent.get(r.events.id) || []).map(ev => ({
        id: ev.vendorId,
        businessName: ev.businessName,
        slug: ev.slug,
        logoUrl: ev.logoUrl,
        vendorType: ev.vendorType,
      })),
    }));

    // Count total
    const countResult = searchParams.state
      ? await db
          .select({ count: count() })
          .from(events)
          .leftJoin(venues, eq(events.venueId, venues.id))
          .where(and(...stateConditions))
      : await db
          .select({ count: count() })
          .from(events)
          .where(and(...conditions));

    return {
      events: eventsWithVendors,
      total: countResult[0]?.count || 0,
      page,
      limit,
    };
  } catch (e) {
    console.error("Error fetching events:", e);
    return { events: [], total: 0, page: 1, limit };
  }
}

async function getCategories() {
  try {
    const db = getCloudflareDb();
    const results = await db
      .select({ categories: events.categories })
      .from(events)
      .where(eq(events.status, "APPROVED"));

    const categories = new Set<string>();
    results.forEach((e) => {
      try {
        const cats = JSON.parse(e.categories || "[]");
        cats.forEach((c: string) => categories.add(c));
      } catch {}
    });
    return Array.from(categories).sort();
  } catch {
    return [];
  }
}

async function getStates() {
  try {
    const db = getCloudflareDb();
    const results = await db
      .selectDistinct({ state: venues.state })
      .from(venues)
      .where(eq(venues.status, "ACTIVE"));

    return results.map((v) => v.state).sort();
  } catch {
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
      {searchParams.view && (
        <input type="hidden" name="view" value={searchParams.view} />
      )}

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
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Search
        </label>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            name="query"
            defaultValue={searchParams.query}
            placeholder="Search events..."
            className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Category
        </label>
        <select
          name="category"
          defaultValue={searchParams.category}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
        <label className="block text-sm font-medium text-gray-700 mb-1">
          State
        </label>
        <select
          name="state"
          defaultValue={searchParams.state}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">All States</option>
          {states.map((state) => (
            <option key={state} value={state}>
              {state}
            </option>
          ))}
        </select>
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          name="featured"
          value="true"
          defaultChecked={searchParams.featured === "true"}
          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
        />
        <span className="text-sm text-gray-700">Featured only</span>
      </label>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          name="commercialVendors"
          value="true"
          defaultChecked={searchParams.commercialVendors === "true"}
          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
        />
        <span className="text-sm text-gray-700">Commercial vendors allowed</span>
      </label>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          name="includeTBD"
          value="true"
          defaultChecked={searchParams.includeTBD === "true"}
          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
        />
        <span className="text-sm text-gray-700">Include dates TBD</span>
      </label>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          name="includePast"
          value="true"
          defaultChecked={searchParams.includePast === "true"}
          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
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
          className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
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

  // Get vendor event IDs if the user is a vendor and wants to filter
  let vendorEventIds: string[] | undefined;
  if (isVendor && params.myEvents === "true") {
    const vendorId = await getVendorIdForUser(session.user.id);
    if (vendorId) {
      vendorEventIds = await getVendorEventIds(vendorId);
    }
  }

  // Get favorite IDs if user wants to filter by favorites
  let favoriteIds: string[] | undefined;
  if (isLoggedIn && params.favorites === "true") {
    favoriteIds = await getUserFavoriteIds(session.user.id, "EVENT");
  }

  const viewMode = parseView(params.view);
  const isCalendarView = viewMode === "calendar";

  const [{ events: eventsList, total, page, limit }, categories, states] =
    await Promise.all([getEvents(params, vendorEventIds, favoriteIds), getCategories(), getStates()]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Browse Events</h1>
        <p className="mt-2 text-gray-600">
          Discover upcoming fairs, festivals, and community events
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        <aside className="lg:col-span-1">
          <Suspense fallback={<div className="animate-pulse bg-gray-200 h-64 rounded-lg" />}>
            <EventsFilter
              categories={categories}
              states={states}
              searchParams={params}
              isVendor={isVendor}
              isLoggedIn={isLoggedIn}
            />
          </Suspense>
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
          />
        </main>
      </div>
    </div>
  );
}
