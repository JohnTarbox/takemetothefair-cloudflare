import { Suspense } from "react";
import { Search, Filter, Store } from "lucide-react";
import { EventsView } from "@/components/events/events-view";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, promoters, eventVendors, vendors } from "@/lib/db/schema";
import { eq, and, gte, or, count, inArray, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";

export const runtime = "edge";
export const dynamic = "force-dynamic"; // Disable caching for fresh data


interface SearchParams {
  query?: string;
  category?: string;
  state?: string;
  featured?: string;
  commercialVendors?: string;
  includePast?: string;
  myEvents?: string;
  page?: string;
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

async function getEvents(searchParams: SearchParams, vendorEventIds?: string[]) {
  const page = parseInt(searchParams.page || "1");
  const limit = 12;
  const offset = (page - 1) * limit;

  try {
    const db = getCloudflareDb();

    // Build conditions
    const conditions = [
      eq(events.status, "APPROVED"),
    ];

    // Only filter to future events unless includePast is true
    if (searchParams.includePast !== "true") {
      conditions.push(gte(events.endDate, new Date()));
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

    // Get events with joins
    let query = db
      .select()
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(and(...conditions))
      .orderBy(events.startDate)
      .limit(limit)
      .offset(offset);

    // Filter by state if provided (after join)
    if (searchParams.state) {
      query = db
        .select()
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .leftJoin(promoters, eq(events.promoterId, promoters.id))
        .where(and(...conditions, eq(venues.state, searchParams.state)))
        .orderBy(events.startDate)
        .limit(limit)
        .offset(offset);
    }

    const results = await query;

    // Fetch vendors for each event
    const eventsWithVendors = await Promise.all(
      results.map(async (r) => {
        const eventVendorResults = await db
          .select()
          .from(eventVendors)
          .leftJoin(vendors, eq(eventVendors.vendorId, vendors.id))
          .where(
            and(
              eq(eventVendors.eventId, r.events.id),
              eq(eventVendors.status, "APPROVED")
            )
          );

        return {
          ...r.events,
          venue: r.venues,
          promoter: r.promoters,
          vendors: eventVendorResults
            .filter((ev) => ev.vendors !== null)
            .map((ev) => ({
              id: ev.vendors!.id,
              businessName: ev.vendors!.businessName,
              slug: ev.vendors!.slug,
              logoUrl: ev.vendors!.logoUrl,
              vendorType: ev.vendors!.vendorType,
            })),
        };
      })
    );

    // Count total
    const countConditions = [...conditions];
    if (searchParams.state) {
      const countResult = await db
        .select({ count: count() })
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .where(and(...countConditions, eq(venues.state, searchParams.state)));

      return {
        events: eventsWithVendors,
        total: countResult[0]?.count || 0,
        page,
        limit,
      };
    }

    const countResult = await db
      .select({ count: count() })
      .from(events)
      .where(and(...countConditions));

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
}: {
  categories: string[];
  states: string[];
  searchParams: SearchParams;
  isVendor?: boolean;
}) {
  return (
    <form className="bg-white p-4 rounded-lg border border-gray-200 space-y-4">
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
          name="includePast"
          value="true"
          defaultChecked={searchParams.includePast === "true"}
          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
        />
        <span className="text-sm text-gray-700">Include past events</span>
      </label>

      <div className="flex gap-2">
        <button
          type="submit"
          className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
        >
          <Filter className="w-4 h-4" />
          Apply Filters
        </button>
        <a
          href="/events"
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

  // Get vendor event IDs if the user is a vendor and wants to filter
  let vendorEventIds: string[] | undefined;
  if (isVendor && params.myEvents === "true") {
    const vendorId = await getVendorIdForUser(session.user.id);
    if (vendorId) {
      vendorEventIds = await getVendorEventIds(vendorId);
    }
  }

  const [{ events: eventsList, total, page, limit }, categories, states] =
    await Promise.all([getEvents(params, vendorEventIds), getCategories(), getStates()]);

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
            />
          </Suspense>
        </aside>

        <main className="lg:col-span-3">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-gray-600">
              {params.myEvents === "true" ? (
                <>Showing {eventsList.length} of {total} events you&apos;re participating in</>
              ) : (
                <>Showing {eventsList.length} of {total} events</>
              )}
            </p>
          </div>

          <EventsView
            events={eventsList}
            emptyMessage={
              params.myEvents === "true"
                ? "You are not participating in any events yet. Apply to events to see them here."
                : "No events match your filters. Try adjusting your search."
            }
          />

          {totalPages > 1 && (
            <div className="mt-8 flex justify-center gap-2">
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <a
                  key={p}
                  href={`/events?${new URLSearchParams({
                    ...params,
                    page: p.toString(),
                  } as Record<string, string>).toString()}`}
                  className={`px-4 py-2 rounded-lg ${
                    p === page
                      ? "bg-blue-600 text-white"
                      : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  {p}
                </a>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
