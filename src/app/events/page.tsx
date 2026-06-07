import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { Search, Filter, Store, Heart } from "lucide-react";
import { EventsView } from "@/components/events/events-view";
import { upcomingEndPredicate } from "@/lib/event-dates";
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
import { attachEventDayDates } from "@/lib/event-days-attach";
import { eventJoinProjection } from "@/lib/db/event-join-projection";
import { auth } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { sanitizeLikeInput } from "@/lib/utils";
import { ItemListSchema } from "@/components/seo/ItemListSchema";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { MobileFilterDrawer } from "@/components/ui/mobile-filter-drawer";
import { countPublicFilteredEvents, hasPublicFilters } from "@/lib/events-filter-count";

export const runtime = "edge";
export const revalidate = 300; // Cache for 5 minutes

const BASE_METADATA: Metadata = {
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

// Emit `robots: noindex,follow` on filtered listings that resolve to
// zero results. These pages return HTTP 200 with a "no events match"
// UI which Google's crawler treats as a soft 404 — they dilute crawl
// budget and overall quality signals. Unfiltered /events is never
// noindex'd (it's the canonical listing). The count query mirrors
// public-filter conditions only (no myEvents/favorites — those
// require auth and never appear in indexable URLs).
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const resolved = await searchParams;
  if (!hasPublicFilters(resolved)) return BASE_METADATA;
  try {
    const db = getCloudflareDb();
    const matchCount = await countPublicFilteredEvents(db, resolved);
    if (matchCount > 0) return BASE_METADATA;
    return {
      ...BASE_METADATA,
      robots: { index: false, follow: true },
    };
  } catch {
    // If the count probe errors, fall back to indexable — better to
    // let Google see the page than to noindex by accident on a
    // transient D1 hiccup. The page handler has its own try/catch.
    return BASE_METADATA;
  }
}

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
    // - default: only events with a real start date that hasn't ended yet.
    //   Excluding NULL start_date keeps undated TENTATIVE rows out of the
    //   upcoming feed (where ORDER BY start_date ASC otherwise floats them).
    if (searchParams.includePast !== "true") {
      conditions.push(isNotNull(events.startDate));
      // A2 (Dev backlog 2026-06-05): give every event a 24h grace so an
      // evening event whose stored end_date sits at noon UTC the same
      // calendar day doesn't drop out of the upcoming feed at 8am EDT.
      conditions.push(upcomingEndPredicate(new Date()));
    }

    if (searchParams.query) {
      // Strip LIKE wildcards (`%`, `_`) before constructing the pattern so a
      // user query of "%" doesn't degenerate to "match every row." Drizzle
      // parameterizes the value, so this is wildcard hygiene, not SQL escape.
      const query = sanitizeLikeInput(searchParams.query.toLowerCase().trim());
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
      // Match BOTH the categories array AND the event name. Many farmers-market
      // events are imported without the "Farmers Market" category tag
      // (e.g. "Bath Farmers Market" with categories=["Market"]), so the category
      // test alone misses them. NULL categories pass the categories test (we
      // only filter out positive matches), and events.name is NOT NULL so the
      // name notLike applies cleanly to every row.
      conditions.push(
        and(
          or(notLike(events.categories, "%Farmers Market%"), isNull(events.categories)),
          notLike(events.name, "%Farmers Market%")
        )!
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

    // COALESCE protects ORDER BY against NULL start_date even though the
    // default (no includePast) WHERE clause already excludes them. When
    // includePast=true, NULL-start TBD rows are present and would otherwise
    // float to the top under plain ASC; 9999999999 (year 2286) sorts them last.
    const startDateAsc = sql`COALESCE(${events.startDate}, 9999999999) ASC`;
    const orderByMap = {
      "date-asc": startDateAsc,
      "date-desc": desc(events.startDate),
      "name-asc": asc(events.name),
      "name-desc": desc(events.name),
      popular: desc(events.viewCount),
    };
    const orderBy = orderByMap[sort as keyof typeof orderByMap] || startDateAsc;

    // Narrow projection — D1 caps result rows at 100 columns; the
    // default `db.select()` over events+venues+promoters emits 104
    // columns and fails every render. See eventJoinProjection's
    // docblock for the audit + maintenance contract.
    let query;
    if (isCalendarView) {
      query = db
        .select(eventJoinProjection)
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .leftJoin(promoters, eq(events.promoterId, promoters.id))
        .where(and(...stateConditions))
        .orderBy(orderBy);
    } else {
      query = db
        .select(eventJoinProjection)
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

    // Combine events with their vendors. `venue`/`promoter` here are the
    // lite projections from eventJoinProjection, cast back to the full
    // schema type so EventCard/EventsView's existing `Venue | null` /
    // `Promoter | null` props compile unchanged. The cast is sound:
    // every venue/promoter field consumers actually read is present in
    // the projection (audited 2026-06-04). See event-join-projection.ts
    // for the maintenance contract.
    type FullVenue = typeof venues.$inferSelect;
    type FullPromoter = typeof promoters.$inferSelect;
    // EventRow is derived from the actual query result so any change
    // to eventJoinProjection (or its replacement) flows through here
    // automatically — no hand-typed parameter to drift.
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
      // Include specific dates for discontinuous events (calendar view).
      // The calendar view already pre-loaded these into daysByEvent; for
      // the cards view we fall through to attachEventDayDates below
      // (which the discontinuous path will short-circuit on, since the
      // map will already have entries from daysByEvent).
      ...(r.events.discontinuousDates && daysByEvent.has(r.events.id)
        ? { eventDayDates: daysByEvent.get(r.events.id) }
        : {}),
    }));

    // Cohort 7 follow-up (2026-06-01) — attach event_days for ALL events
    // (not just calendar-view discontinuous ones) so EventCard's date
    // badge resolves the next occurrence everywhere. Idempotent: if the
    // event already has eventDayDates from the calendar-view path above,
    // attachEventDayDates re-populates it with the same data (same SELECT
    // shape, same sort). Small cost; one query per page render.
    const eventsWithVendors = await attachEventDayDates(db, eventsBase);

    // Count total (state filter now lives on events.state_code, so no venue join needed)
    const countResult = await db
      .select({ count: count() })
      .from(events)
      .where(and(...stateConditions));

    const total = countResult[0]?.count || 0;

    // REL1' §3 (2026-06-04): render-time invariant. When the result page
    // is empty AND the user applied no filters AND the total-count says
    // there ARE matching events, that's the silent-zero-result symptom
    // that hid the 2026-06-04 D1 100-col outage. Log a high-signal
    // error_logs row so B2's page-error canary picks it up on the next
    // 10-min cron tick. Only fires on page=1 (no pagination overshoot).
    const hasUserFilter = !!(
      searchParams.query ||
      searchParams.category ||
      searchParams.state ||
      searchParams.indoorOutdoor ||
      searchParams.scale ||
      searchParams.featured ||
      searchParams.commercialVendors ||
      searchParams.excludeFarmersMarkets ||
      searchParams.includePast ||
      searchParams.includeTBD ||
      searchParams.myEvents ||
      searchParams.favorites
    );
    if (page === 1 && eventsWithVendors.length === 0 && total > 0 && !hasUserFilter) {
      await logError(db, {
        message:
          `Render-time invariant tripped: /events page=1 with no filters returned 0 rows but COUNT says ${total}. ` +
          `Likely a query/filter regression; investigate getEvents.`,
        source: "app/events/page.tsx:getEvents",
        context: { invariantTripped: true, total, isCalendarView },
      });
    }

    return {
      events: eventsWithVendors,
      total,
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
    // REL1' §1 (2026-06-04): throw FetchError instead of returning empty.
    // Lets Next.js's error.tsx render a "service temporarily unavailable"
    // page that's visibly + crawler-visibly distinct from a real zero-
    // result empty state. The 2026-06-04 D1 100-col outage took 17h to
    // detect partly because the empty-list looked exactly like a real
    // empty filter.
    const { FetchError } = await import("@/lib/errors/fetch-error");
    throw new FetchError("app/events/page.tsx:getEvents", e);
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
    <form className="bg-card p-4 rounded-lg border border-border space-y-4">
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
        <label className="block text-sm font-medium text-foreground mb-1" htmlFor="events-search">
          Search
        </label>
        {/* A5 (2026-06-04): inline submit button gives the search field a
            discoverable affordance — previously the only way to fire the
            search was Enter or the "Apply Filters" button at the bottom
            of the long form, and users reported missing the search entirely.
            Submitting still posts the whole filter form (same URL state),
            so the behavior is unchanged — just visible. */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            id="events-search"
            type="text"
            name="query"
            defaultValue={searchParams.query}
            placeholder="Search events..."
            className="w-full pl-10 pr-12 py-2 border border-input rounded-lg focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
          />
          <button
            type="submit"
            aria-label="Search events"
            className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex items-center justify-center min-w-[32px] min-h-[32px] px-2.5 rounded-md bg-royal text-white text-sm font-medium hover:bg-royal/90 focus:outline-none focus:ring-2 focus:ring-royal focus:ring-offset-1 transition-colors"
          >
            Go
          </button>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-foreground mb-1">Category</label>
        <select
          name="category"
          defaultValue={searchParams.category}
          className="w-full px-3 py-2 border border-input rounded-lg focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
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
        <label className="block text-sm font-medium text-foreground mb-1">State</label>
        <select
          name="state"
          defaultValue={searchParams.state}
          className="w-full px-3 py-2 border border-input rounded-lg focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
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
        <label className="block text-sm font-medium text-foreground mb-1">Indoor/Outdoor</label>
        <select
          name="indoorOutdoor"
          defaultValue={searchParams.indoorOutdoor}
          className="w-full px-3 py-2 border border-input rounded-lg focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
        >
          <option value="">Any</option>
          <option value="INDOOR">Indoor</option>
          <option value="OUTDOOR">Outdoor</option>
          <option value="MIXED">Mixed</option>
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-foreground mb-1">Event Scale</label>
        <select
          name="scale"
          defaultValue={searchParams.scale}
          className="w-full px-3 py-2 border border-input rounded-lg focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
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
          className="rounded border-input text-royal focus:ring-royal"
        />
        <span className="text-sm text-foreground">Featured only</span>
      </label>

      <fieldset className="border-t border-border pt-3">
        <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Vendor & event type
        </legend>

        <label className="flex items-start gap-2 mb-2">
          <input
            type="checkbox"
            name="commercialVendors"
            value="true"
            defaultChecked={searchParams.commercialVendors === "true"}
            className="mt-0.5 rounded border-input text-royal focus:ring-royal"
          />
          <span className="text-sm text-foreground">
            Only shows that allow commercial vendors
            <span className="block text-xs text-muted-foreground">
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
            className="mt-0.5 rounded border-input text-royal focus:ring-royal"
          />
          <span className="text-sm text-foreground">Hide farmers markets</span>
        </label>
      </fieldset>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          name="includePast"
          value="true"
          defaultChecked={searchParams.includePast === "true"}
          className="rounded border-input text-royal focus:ring-royal"
        />
        <span className="text-sm text-foreground">Include past events</span>
      </label>

      {isLoggedIn && (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="favorites"
            value="true"
            defaultChecked={searchParams.favorites === "true"}
            className="rounded border-input text-pink-600 focus:ring-pink-500"
          />
          <Heart className="w-4 h-4 text-pink-500" />
          <span className="text-sm text-foreground">My Favorites</span>
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
          className="px-4 py-2 border border-input text-foreground rounded-lg hover:bg-muted transition-colors"
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
        positionStart={(page - 1) * limit + 1}
        asCollectionPage
        pageUrl="https://meetmeatthefair.com/events"
      />
      <div className="mb-8 print:hidden">
        <h1 className="text-3xl font-bold text-foreground">Browse Events</h1>
        <p className="mt-2 text-muted-foreground">
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
          <div className="mt-8 bg-muted rounded-lg p-6 text-center border border-border print:hidden">
            <h3 className="text-lg font-semibold text-foreground mb-2">Looking for past events?</h3>
            <p className="text-sm text-muted-foreground mb-3">
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
