import type { Metadata } from "next";
import { isD1PlatformFault } from "@/lib/db/degraded";
import { DegradedPanel } from "@/components/layout/degraded-panel";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { parseListingPage } from "@/lib/listing-page-param";
import { Search, Filter, Store, Heart, X } from "lucide-react";
import { EventsView } from "@/components/events/events-view";
import { CalendarSSR } from "@/components/events/calendar-ssr";
import { getCloudflareDb, getCloudflareRateLimitKv } from "@/lib/cloudflare";
import { eq } from "drizzle-orm";
import { vendors } from "@/lib/db/schema";
import { logError } from "@/lib/logger";
import {
  canServeEventsFromCache,
  getCachedEventCategories,
  getCachedEventStates,
  loadEventsListingCached,
  loadEventsListingLive,
} from "@/lib/events/events-listing";
import { auth } from "@/lib/auth";
import { ItemListSchema } from "@/components/seo/ItemListSchema";
import { ItemListTracker } from "@/components/analytics/ItemListTracker";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { MobileFilterDrawer } from "@/components/ui/mobile-filter-drawer";
import { countPublicFilteredEvents, hasPublicFilters } from "@/lib/events-filter-count";
import { withD1ReadLogged } from "@/lib/db/d1-resilience";
import {
  DAYS_FILTERS,
  DAYS_FILTER_LABELS,
  DAYS_FILTER_SHORT_LABELS,
  parseDaysFilter,
} from "@/lib/events/days-filter";

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
    // OPE-1668 — the same cached set the page body reads, so a crawled filter
    // URL costs no D1 count of its own (and the noindex decision now agrees
    // with what the page renders, including the week/weekend occurrence test).
    const matchCount = canServeEventsFromCache(resolved, { isCalendarView: false })
      ? (
          await loadEventsListingCached(db, getCloudflareRateLimitKv(), resolved, {
            page: 1,
            limit: 1,
            isCalendarView: false,
          })
        ).total
      : await countPublicFilteredEvents(db, resolved);
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
  when?: string;
  /** OPE-1487 — day-of-week filter: weekday-only | weekday-any | weekend-only | weekend-any. */
  days?: string;
  myEvents?: string;
  favorites?: string;
  indoorOutdoor?: string;
  scale?: string;
  page?: string;
  view?: string;
  sort?: string;
  /** CAL1 — visible month for the SSR calendar ("YYYY-MM"). */
  cal?: string;
  /** CAL2 — SSR calendar sub-view ("month" | "agenda" | "year" | "week" | "day" | "custom"); default "month". */
  cal_view?: string;
  /** CAL2 — visible year for the Year sub-view ("YYYY"); default current year. */
  cal_year?: string;
  /** CAL2 — anchor date ("YYYY-MM-DD") for the Week/Day/Custom time-grid views; default today. */
  cal_date?: string;
  /** OPE-1488 — the calendar's focus date ("YYYY-MM-DD"), shared by every sub-view. */
  date?: string;
  /** CAL2 — day count (2–7) for the Custom time-grid view; default 3. */
  cal_days?: string;
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

/**
 * OPE-790 — one jittered retry on a Cloudflare-side D1 blip before the failure
 * reaches the user. Wraps the fetcher rather than its body so every call site
 * inherits it, and so the diagnostic catch inside stays exactly as OPE-548 left
 * it. Only a PLATFORM fault is retried; a query defect fails the same way twice.
 */
function getEvents(
  searchParams: SearchParams,
  vendorId?: string,
  favoriteUserId?: string,
  includeVendorDays?: boolean
) {
  return withD1ReadLogged("app/events/page.tsx:getEvents", () =>
    getEventsOnce(searchParams, vendorId, favoriteUserId, includeVendorDays)
  );
}

async function getEventsOnce(
  searchParams: SearchParams,
  vendorId?: string,
  favoriteUserId?: string,
  includeVendorDays?: boolean
) {
  const viewMode = parseView(searchParams.view);
  const isCalendarView = viewMode === "calendar";
  // Validated by the page component before this runs (OPE-1573).
  const page = parseListingPage(searchParams.page) ?? 1;
  const limit = 30;
  const sort = searchParams.sort || "date-asc";

  const db = getCloudflareDb();

  // OPE-548 — diagnostic holders, populated by the live loader so the catch can
  // describe the query that failed.
  let builtQuery: { toSQL: () => { sql: string; params: unknown[] } } | undefined;
  let conditionCount = 0;

  try {
    // OPE-1668 — a render with no free-text query, no per-user filter and no
    // includePast is a filter/sort/slice of ONE cached set (see
    // src/lib/events/events-listing.ts); everything else reads live.
    const { events: eventsWithVendors, total } = canServeEventsFromCache(searchParams, {
      isCalendarView,
      includeVendorDays,
    })
      ? await loadEventsListingCached(db, getCloudflareRateLimitKv(), searchParams, {
          page,
          limit,
          isCalendarView,
        })
      : await loadEventsListingLive(db, searchParams, {
          page,
          limit,
          isCalendarView,
          includeVendorDays,
          vendorId,
          favoriteUserId,
          onQueryBuilt: (q, n) => {
            builtQuery = q;
            conditionCount = n;
          },
        });

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
      searchParams.when ||
      searchParams.days ||
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

    // NOTE: the visible card sort by next-occurrence date is applied CLIENT-side
    // in <EventsView> (sortData's startDate accessor → displayDate), because
    // that component re-sorts the list it receives. The server-side order
    // still drives pagination boundaries.

    return {
      events: eventsWithVendors,
      total,
      page,
      limit,
    };
  } catch (e) {
    // OPE-548 — log what BUILT the query, not just how it was paginated.
    //
    // All 38 logged occurrences of the D1 pattern-complexity error carried a
    // byte-identical context — `{isCalendarView:false, page:1, limit:30}` —
    // because the filter inputs that construct the predicates were never
    // recorded. `url` and `user_agent` were NULL too. The result was an error
    // firing every few minutes for two days that no one could attribute to a
    // request shape: I probed production with pattern lengths to 202, 120
    // literal `%`, dense `_`, and a 200-char category and reproduced none of
    // them, while organic traffic kept failing throughout.
    //
    // So this logs the inputs AND the generated SQL. `toSQL()` is what makes
    // the next occurrence self-diagnosing rather than another identical row:
    // it names the exact predicate and the parameter that broke it. Guarded in
    // its own try — a diagnostic must never replace the error it describes.
    let generatedSql: string | undefined;
    let paramShapes: string | undefined;
    try {
      const compiled = builtQuery?.toSQL();
      if (compiled) {
        generatedSql = String(compiled.sql).slice(0, 1500);
        paramShapes = JSON.stringify(
          (compiled.params ?? []).map((p: unknown) =>
            typeof p === "string" ? { len: p.length, head: p.slice(0, 40) } : typeof p
          )
        ).slice(0, 1500);
      }
    } catch {
      generatedSql = "<toSQL() unavailable>";
    }
    await logError(db, {
      message: "Error fetching events",
      error: e,
      source: "app/events/page.tsx:getEvents",
      context: {
        isCalendarView,
        page,
        limit,
        sort,
        // The predicate-building inputs. Truncated because they are arbitrary
        // user input and this row is written on every failure.
        filters: {
          query: searchParams.query?.slice(0, 120) ?? null,
          queryLen: searchParams.query?.length ?? 0,
          category: searchParams.category?.slice(0, 120) ?? null,
          categoryLen: searchParams.category?.length ?? 0,
          state: searchParams.state ?? null,
          when: searchParams.when ?? null,
          days: searchParams.days ?? null,
          view: searchParams.view ?? null,
          includePast: searchParams.includePast ?? null,
          includeTBD: searchParams.includeTBD ?? null,
          featured: searchParams.featured ?? null,
          commercialVendors: searchParams.commercialVendors ?? null,
          excludeFarmersMarkets: searchParams.excludeFarmersMarkets ?? null,
          indoorOutdoor: searchParams.indoorOutdoor ?? null,
          scale: searchParams.scale ?? null,
          myEvents: searchParams.myEvents ?? null,
          favorites: searchParams.favorites ?? null,
        },
        conditionCount,
        generatedSql,
        paramShapes,
      },
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

// OPE-1668 — both were whole-table scans on every render; now KV-cached (300s).
// A failure still degrades to an empty sidebar list, and is not cached.
async function getCategories() {
  try {
    return await getCachedEventCategories(getCloudflareDb(), getCloudflareRateLimitKv());
  } catch (error) {
    console.error("Failed to fetch event categories", { error });
    return [];
  }
}

async function getStates() {
  try {
    return await getCachedEventStates(getCloudflareDb(), getCloudflareRateLimitKv());
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
      {/* Preserve the calendar sub-view + anchor so applying a filter doesn't
          reset the calendar back to Month / today. */}
      {searchParams.cal_view && (
        <input type="hidden" name="cal_view" value={searchParams.cal_view} />
      )}
      {searchParams.cal && <input type="hidden" name="cal" value={searchParams.cal} />}
      {searchParams.cal_year && (
        <input type="hidden" name="cal_year" value={searchParams.cal_year} />
      )}
      {searchParams.cal_date && (
        <input type="hidden" name="cal_date" value={searchParams.cal_date} />
      )}
      {searchParams.date && <input type="hidden" name="date" value={searchParams.date} />}
      {searchParams.cal_days && (
        <input type="hidden" name="cal_days" value={searchParams.cal_days} />
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
            className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex items-center justify-center min-w-[32px] min-h-[32px] px-2.5 rounded-md bg-secondary text-secondary-foreground text-sm font-medium hover:bg-royal/90 focus:outline-none focus:ring-2 focus:ring-royal focus:ring-offset-1 transition-colors"
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
        <label className="block text-sm font-medium text-foreground mb-1" htmlFor="events-days">
          Days
        </label>
        <select
          id="events-days"
          name="days"
          defaultValue={parseDaysFilter(searchParams.days) ?? ""}
          aria-describedby="events-days-hint"
          className="w-full px-3 py-2 border border-input rounded-lg focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
        >
          <option value="">Any day</option>
          {DAYS_FILTERS.map((f) => (
            <option key={f} value={f}>
              {DAYS_FILTER_LABELS[f]}
            </option>
          ))}
        </select>
        <p id="events-days-hint" className="text-xs text-muted-foreground mt-1">
          &ldquo;Only&rdquo; means every open day; &ldquo;Open on&rdquo; means at least one.
        </p>
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
          className="flex-1 bg-secondary text-secondary-foreground py-2 px-4 rounded-lg hover:bg-secondary/90 transition-colors flex items-center justify-center gap-2"
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

export const dynamic = "force-dynamic";

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

  // OPE-1573 — a malformed ?page= 404s here, before auth() and any D1 query.
  if (parseListingPage(params.page) === null) notFound();

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
  // CAL1/CAL2 — the calendar view is the SSR calendar (Month + Agenda/Year/
  // Week/Day sub-views). The CAL1_SSR_MONTH / CAL2_VIEWS flags that gated it
  // were pinned "true" permanently (OPE-994) and retired in OPE-1394.
  const useSsrCalendar = viewMode === "calendar";
  let loaded: [
    Awaited<ReturnType<typeof getEvents>>,
    Awaited<ReturnType<typeof getCategories>>,
    Awaited<ReturnType<typeof getStates>>,
  ];
  try {
    loaded = await Promise.all([
      getEvents(params, vendorId, favoriteUserId, isVendor || session?.user?.role === "ADMIN"),
      getCategories(),
      getStates(),
    ]);
  } catch (e) {
    // OPE-790 rework (John, 10-04) — an honest degraded panel, not the error
    // boundary, when a D1 platform blip survives the retry. Our own query
    // defects still throw. (No noindex here: this route's metadata cannot see
    // the failure — see the OPE-790 receipt.)
    if (isD1PlatformFault(e)) return <DegradedPanel what="events" retryHref="/events" />;
    throw e;
  }
  const [{ events: eventsList, total, page, limit }, categories, states] = loaded;

  const totalPages = Math.ceil(total / limit);

  // C2 — the `when` date filter (set by the homepage "This weekend/month" chips)
  // is the one active filter not represented in the EventsFilter sidebar, so
  // surface it as a dismissible pill. The ✕ clears `when` (and resets to page 1)
  // while preserving every other active filter.
  const whenLabel =
    params.when === "week"
      ? "This week"
      : params.when === "weekend"
        ? "This weekend"
        : params.when === "month"
          ? "This month"
          : null;
  const clearWhenParams = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k !== "when" && k !== "page" && typeof v === "string" && v) clearWhenParams.set(k, v);
  }
  const clearWhenHref = clearWhenParams.toString()
    ? `/events?${clearWhenParams.toString()}`
    : "/events";

  return (
    <div
      className={`mx-auto ${useSsrCalendar ? "max-w-screen-2xl" : "max-w-7xl"} px-4 sm:px-6 lg:px-8 py-8 print:max-w-none print:px-0 print:py-0`}
    >
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
      <ItemListTracker
        listName="events_listing"
        hrefPrefix="/events"
        items={eventsList.map((e) => ({ id: e.id, slug: e.slug, name: e.name }))}
      />
      <div className="mb-8 print:hidden">
        <h1 className="text-3xl font-bold text-foreground">Browse Events</h1>
        <p className="mt-2 text-muted-foreground">
          Discover upcoming fairs, festivals, and community events
        </p>
        {whenLabel && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Filtered to:</span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber/40 bg-amber-light py-1 pl-3 pr-1.5 text-sm font-semibold text-secondary">
              {whenLabel}
              <Link
                href={clearWhenHref}
                aria-label={`Clear ${whenLabel} filter`}
                className="inline-flex items-center justify-center rounded-full p-0.5 text-secondary/70 hover:bg-secondary/10 hover:text-secondary"
              >
                <X className="h-3.5 w-3.5" />
              </Link>
            </span>
          </div>
        )}
      </div>

      {useSsrCalendar ? (
        // Calendar view: full-width grid (Google-Calendar-like). The site filters
        // move into a collapsible disclosure above the calendar so the 7-day grid
        // gets the whole width instead of competing with a left sidebar.
        <div className="space-y-6">
          <details className="rounded-lg border border-border bg-card print:hidden">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-foreground">
              <Filter className="h-4 w-4" />
              Filters
            </summary>
            <div className="border-t border-border p-4">
              <EventsFilter
                categories={categories}
                states={states}
                searchParams={params}
                isVendor={isVendor}
                isLoggedIn={isLoggedIn}
              />
            </div>
          </details>

          <CalendarSSR
            events={eventsList}
            searchParams={params as Record<string, string | undefined>}
          />

          <CalendarPastEventsCta />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-8 print:block">
          <aside className="lg:col-span-1 print:hidden">
            <MobileFilterDrawer>
              <Suspense fallback={<div className="animate-pulse bg-muted h-64 rounded-lg" />}>
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
                  : parseDaysFilter(params.days)
                    ? `No events match “${DAYS_FILTER_SHORT_LABELS[parseDaysFilter(params.days)!]}” with your other filters. Try “Any day” or the other weekday/weekend option.`
                    : "No events match your filters. Try adjusting your search."
              }
              currentPage={page}
              totalPages={totalPages}
              searchParams={params as Record<string, string>}
              total={total}
              myEvents={params.myEvents === "true"}
              vendorCoords={vendorCoords}
            />
            <CalendarPastEventsCta />
          </main>
        </div>
      )}
    </div>
  );
}

/** Shared "Looking for past events?" call-to-action below the events area. */
function CalendarPastEventsCta() {
  return (
    <div className="mt-8 bg-muted rounded-lg p-6 text-center border border-border print:hidden">
      <h3 className="text-lg font-semibold text-foreground mb-2">Looking for past events?</h3>
      <p className="text-sm text-muted-foreground mb-3">
        Browse fairs and festivals from previous seasons, including event details and vendor
        information.
      </p>
      <Link
        href="/events/past"
        className="inline-flex items-center gap-2 px-4 py-2 bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/90 transition-colors text-sm font-medium"
      >
        Browse past events &rarr;
      </Link>
    </div>
  );
}
