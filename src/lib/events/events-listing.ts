/**
 * OPE-1668 — the main `/events` listing, live and cached.
 *
 * ── What was happening ─────────────────────────────────────────────────────
 *
 * Every `/events?…` render ran, from scratch, the filtered listing SELECT, a
 * `count(*)` of the same predicate, a vendor batch and an `event_days` batch —
 * and `generateMetadata` ran a second `count(*)` for the noindex decision, and
 * the filter sidebar ran a whole-table categories scan and two DISTINCT state
 * scans. A crawl of distinct filter and `?page=` URLs paid all of it per URL.
 * OPE-1662 (#1820) moved the state and facet pages onto cached sets; this is
 * the same treatment for the main listing, which #1820 split out because its
 * filter space is much larger.
 *
 * ── What it does now ───────────────────────────────────────────────────────
 *
 *  1. ONE cached copy of every upcoming public event (all states, ~650 on prod
 *     2026-11-17), card-shaped, built by `loadEventsListingLive` itself — the
 *     same code the page runs live — with no filters, unpaged, in calendar
 *     shape (so it carries `eventDayHours` and serves the calendar view too).
 *  2. The simple column filters are applied to it IN MEMORY: `category`,
 *     `featured`, `commercialVendors`, `excludeFarmersMarkets`, `indoorOutdoor`,
 *     `scale`, the `when` start-date cap, and the five sorts. Each one is a port
 *     of a one-line SQL predicate, and each has a parity test against the live
 *     SQL that has been driven red (events-listing-ope1668.test.ts).
 *  3. The predicates that are NOT one line — the `state` CASE/EXISTS, the
 *     `when=week|weekend` event_days occurrence test, the `days` weekday/weekend
 *     classifier — are NOT ported. Each is run as SQL, once per TTL per value,
 *     as a cached id set (`getCachedPredicateIds`), and the set is intersected
 *     in memory. Their value spaces are small (a state code; a day window; one
 *     of four `days` values × today), so a crawl of every combination costs one
 *     id query per value, not one listing scan per URL.
 *
 * So paging, sorting and combining filters cost no D1 at all on a warm cache.
 *
 * Stays LIVE (unchanged): free-text `query` (unbounded input), the per-user
 * `myEvents` / `favorites`, `includePast=true` (the whole history — caching it
 * unpaged would be the full events table), a vendor/admin CALENDAR (it shows
 * vendor-only days), and a `state` that is not two ASCII letters (SQLite's
 * `upper()` is ASCII-only, so a cache key built with JS `toUpperCase()` could
 * merge inputs SQL keeps apart).
 *
 * TTL 300s — the staleness the route already declares (`revalidate = 300`).
 * Fails open to D1 via `kvReadThrough`.
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  notLike,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  events,
  venues,
  promoters,
  eventVendors,
  vendors,
  userFavorites,
  eventDays,
  eventInStateWhere,
} from "@/lib/db/schema";
import type { getCloudflareDb } from "@/lib/cloudflare";
import { isPublicEventStatus } from "@/lib/event-status";
import {
  upcomingEndPredicate,
  whenWindowEnd,
  hasOccurrenceInWindowOrUndated,
  utcDateStr,
} from "@/lib/event-dates";
import { isPubliclyVisibleVendorLink } from "@/lib/vendor-status";
import { attachEventDayDates } from "@/lib/event-days-attach";
import { eventJoinProjection } from "@/lib/db/event-join-projection";
import { containsCI } from "@/lib/db/contains-ci";
import { searchTrigrams, trigramMinMatches } from "@/lib/events/search-trigrams";
import {
  daysFilterPredicate,
  easternDateStr,
  parseDaysFilter,
  type DaysFilter,
} from "@/lib/events/days-filter";
import { kvReadThrough, type ReadThroughKv } from "@/lib/kv-read-through";
import { cacheRoundTrip, fromCacheable } from "@/lib/cache-codec";
import { pageSlice } from "@/lib/events/state-listing-cache";

type ListingDb = ReturnType<typeof getCloudflareDb>;

export const EVENTS_LISTING_CACHE_TTL_SECONDS = 300;

/** Bump when the cached shape changes, so an old entry is never decoded as new. */
const KEY_PREFIX = "listing:v2:events";

export const EVENTS_UPCOMING_SET_KEY = `${KEY_PREFIX}:upcoming-set`;

/** The `/events` query-string fields this module reads. */
export interface EventsListingParams {
  query?: string;
  category?: string;
  state?: string;
  featured?: string;
  commercialVendors?: string;
  excludeFarmersMarkets?: string;
  includePast?: string;
  when?: string;
  days?: string;
  myEvents?: string;
  favorites?: string;
  indoorOutdoor?: string;
  scale?: string;
  sort?: string;
}

export interface EventsListingOptions {
  page: number;
  limit: number;
  /** Calendar view: unpaged, with per-day hours for discontinuous events. */
  isCalendarView: boolean;
  /** Include vendor-only days in the calendar's hours (vendors and admins). */
  includeVendorDays?: boolean;
  vendorId?: string;
  favoriteUserId?: string;
  now?: Date;
  /** OPE-548 — the page's catch logs the built query; this hands it over. */
  onQueryBuilt?: (
    query: { toSQL: () => { sql: string; params: unknown[] } },
    conditionCount: number
  ) => void;
}

const SORTS = ["date-asc", "date-desc", "name-asc", "name-desc", "popular"] as const;
type ListingSort = (typeof SORTS)[number];

function parseSort(sort: string | undefined): ListingSort {
  return (SORTS as readonly string[]).includes(sort ?? "") ? (sort as ListingSort) : "date-asc";
}

/**
 * The /events listing query, moved here from `app/events/(listing)/page.tsx`
 * so the live path and the cached set share one copy. The predicates are
 * unchanged; the one behavioural change is the `events.id` tiebreak on every
 * sort (OPE-1028's fix for the state page, applied here): without a unique key
 * SQLite may order a tie differently for page 1 and page 2, so a row can land
 * on both pages or neither — and the cached path could not be held to an order
 * the live path does not define.
 */
export async function loadEventsListingLive(
  db: ListingDb,
  searchParams: EventsListingParams,
  opts: EventsListingOptions
) {
  const { page, limit, isCalendarView } = opts;
  const offset = (page - 1) * limit;
  const now = opts.now ?? new Date();

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
    conditions.push(upcomingEndPredicate(now));
  }

  // C2 P2 — "this week / this weekend / this month" date window (homepage chips → ?when=).
  const whenEnd = whenWindowEnd(searchParams.when, now);
  if (whenEnd) {
    conditions.push(lte(events.startDate, whenEnd));
    // OPE-48 — for week/weekend, additionally require an actual event_days
    // occurrence within the window (or no event_days at all), so a season-long
    // recurring event whose next day is weeks out doesn't leak in. Keeps this
    // surface in agreement with the homepage "Happening This Week" module that
    // links here via "See all". (month keeps the plain 30-day start cap.)
    if (searchParams.when === "week" || searchParams.when === "weekend") {
      conditions.push(hasOccurrenceInWindowOrUndated(now, whenEnd));
    }
  }

  // OPE-1487 — Days filter. Pure SQL (a few bound params), so it composes
  // with paging and the count. Only upcoming days count unless includePast.
  const daysFilter = parseDaysFilter(searchParams.days);
  if (daysFilter) {
    conditions.push(
      daysFilterPredicate(
        daysFilter,
        searchParams.includePast === "true" ? null : easternDateStr(now)
      )
    );
  }

  if (searchParams.query) {
    // OPE-548 — `instr()` via containsCI, not LIKE: a LIKE pattern has a
    // complexity ceiling in D1 and `instr()` has none, and `%`/`_` are literal
    // to it. See the OPE-548 history in git for the full account.
    const query = searchParams.query.toLowerCase().trim();

    const searchConditions = [
      // Exact substring match (case-insensitive)
      containsCI(events.name, query),
      containsCI(events.description, query),
    ];

    // Fuzzy matching using trigrams for typo tolerance ("Choclate" →
    // cho, hoc, ocl, cla, lat, ate — matches "Chocolate"). OPE-548 — bounded by
    // TRIGRAM_MAX_QUERY_LEN: every trigram is a bound parameter and D1 caps a
    // statement at 100.
    const trigrams = searchTrigrams(query);
    if (trigrams.length > 0) {
      // Require at least 60% of trigrams to match (allows for typos)
      const minMatches = trigramMinMatches(trigrams.length);
      const trigramConditions = trigrams.map(
        (t) => sql`(CASE WHEN ${containsCI(events.name, t)} THEN 1 ELSE 0 END)`
      );
      searchConditions.push(sql`(${sql.join(trigramConditions, sql` + `)}) >= ${minMatches}`);
    }

    conditions.push(or(...searchConditions)!);
  }

  if (searchParams.category) {
    // OPE-548 — instr() via containsCI, not a LIKE built from the query string.
    conditions.push(containsCI(events.categories, searchParams.category));
  }

  if (searchParams.featured === "true") {
    conditions.push(eq(events.featured, true));
  }

  if (searchParams.commercialVendors === "true") {
    // OPE-1606 — unknown stays in; only an explicit no is filtered out.
    conditions.push(sql`${events.commercialVendorsAllowed} IS NOT 0`);
  }

  if (searchParams.excludeFarmersMarkets === "true") {
    // Match BOTH the categories array AND the event name. Many farmers-market
    // events are imported without the "Farmers Market" category tag, so the
    // category test alone misses them. NULL categories pass the categories
    // test (we only filter out positive matches); events.name is NOT NULL.
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
  if (searchParams.myEvents === "true" && opts.vendorId) {
    conditions.push(
      sql`${events.id} IN (SELECT ${eventVendors.eventId} FROM ${eventVendors} WHERE ${eventVendors.vendorId} = ${opts.vendorId})`
    );
  } else if (searchParams.myEvents === "true" && !opts.vendorId) {
    // Vendor has no events, return empty
    return { events: [], total: 0 };
  }

  // Filter by favorites using subquery (avoids D1 bind parameter limit)
  if (searchParams.favorites === "true" && opts.favoriteUserId) {
    conditions.push(
      sql`${events.id} IN (SELECT ${userFavorites.favoritableId} FROM ${userFavorites} WHERE ${userFavorites.userId} = ${opts.favoriteUserId} AND ${userFavorites.favoritableType} = 'EVENT')`
    );
  } else if (searchParams.favorites === "true" && !opts.favoriteUserId) {
    // User has no favorites, return empty
    return { events: [], total: 0 };
  }

  const stateConditions = searchParams.state
    ? [...conditions, eventInStateWhere(searchParams.state)]
    : conditions;

  // COALESCE protects ORDER BY against NULL start_date even though the
  // default (no includePast) WHERE clause already excludes them. When
  // includePast=true, NULL-start TBD rows are present and would otherwise
  // float to the top under plain ASC; 9999999999 (year 2286) sorts them last.
  const startDateAsc = sql`COALESCE(${events.startDate}, 9999999999) ASC`;
  const orderByMap: Record<ListingSort, SQL> = {
    "date-asc": startDateAsc,
    "date-desc": desc(events.startDate),
    "name-asc": asc(events.name),
    "name-desc": desc(events.name),
    popular: desc(events.viewCount),
  };
  const orderBy = orderByMap[parseSort(searchParams.sort)];

  // Narrow projection — D1 caps result rows at 100 columns; see
  // eventJoinProjection's docblock for the audit + maintenance contract.
  const base = db
    .select(eventJoinProjection)
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .leftJoin(promoters, eq(events.promoterId, promoters.id))
    .where(and(...stateConditions))
    .orderBy(orderBy, asc(events.id));
  const query = isCalendarView ? base : base.limit(limit).offset(offset);

  opts.onQueryBuilt?.(query, conditions.length);

  const results = await query;

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
        .where(and(inArray(eventVendors.eventId, batch), isPubliclyVisibleVendorLink()));
      allEventVendors.push(...batchResults);
    }
  }

  const vendorsByEvent = new Map<string, typeof allEventVendors>();
  for (const ev of allEventVendors) {
    const existing = vendorsByEvent.get(ev.eventId) || [];
    existing.push(ev);
    vendorsByEvent.set(ev.eventId, existing);
  }

  // For calendar view, fetch eventDays for discontinuous events: the date list
  // and the per-day hours (`eventDayHours`), which the calendar adapter turns
  // into TIMED occurrences for the Week/Day grid.
  const daysByEvent = new Map<string, string[]>();
  const hoursByEvent = new Map<
    string,
    Array<{ date: string; openTime: string | null; closeTime: string | null }>
  >();
  if (isCalendarView) {
    const discontinuousIds = results
      .filter((r) => r.events.discontinuousDates)
      .map((r) => r.events.id);

    if (discontinuousIds.length > 0) {
      const BATCH_SIZE = 50;
      for (let i = 0; i < discontinuousIds.length; i += BATCH_SIZE) {
        const batch = discontinuousIds.slice(i, i + BATCH_SIZE);
        const dayConditions = [inArray(eventDays.eventId, batch)];
        if (!opts.includeVendorDays) {
          dayConditions.push(eq(eventDays.vendorOnly, false));
        }
        const dayResults = await db
          .select({
            eventId: eventDays.eventId,
            date: eventDays.date,
            openTime: eventDays.openTime,
            closeTime: eventDays.closeTime,
          })
          .from(eventDays)
          .where(and(...dayConditions));
        for (const row of dayResults) {
          const existing = daysByEvent.get(row.eventId) || [];
          existing.push(row.date);
          daysByEvent.set(row.eventId, existing);
          const hrs = hoursByEvent.get(row.eventId) || [];
          hrs.push({ date: row.date, openTime: row.openTime, closeTime: row.closeTime });
          hoursByEvent.set(row.eventId, hrs);
        }
      }
    }
  }

  // `venue`/`promoter` are the lite projections from eventJoinProjection, cast
  // back to the full schema type so EventCard/EventsView's existing props
  // compile unchanged (audited 2026-06-04; see event-join-projection.ts).
  type FullVenue = typeof venues.$inferSelect;
  type FullPromoter = typeof promoters.$inferSelect;
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
    ...(r.events.discontinuousDates && daysByEvent.has(r.events.id)
      ? { eventDayDates: daysByEvent.get(r.events.id) }
      : {}),
    // Per-day hours for the calendar adapter (timed occurrences in Week/Day).
    ...(r.events.discontinuousDates && hoursByEvent.has(r.events.id)
      ? { eventDayHours: hoursByEvent.get(r.events.id) }
      : {}),
  }));

  // Cohort 7 follow-up (2026-06-01) — attach event_days for ALL events so
  // EventCard's date badge resolves the next occurrence everywhere. This
  // overwrites the calendar path's `eventDayDates` with the full list.
  const eventsWithVendors = await attachEventDayDates(db, eventsBase);

  // Count total (state filter lives on events.state_code / venue, no join needed)
  const countResult = await db
    .select({ count: count() })
    .from(events)
    .where(and(...stateConditions));

  return { events: eventsWithVendors, total: countResult[0]?.count || 0 };
}

export type EventsListingCard = Awaited<
  ReturnType<typeof loadEventsListingLive>
>["events"][number] & {
  eventDayHours?: Array<{ date: string; openTime: string | null; closeTime: string | null }>;
};

// ── The cached path ─────────────────────────────────────────────────────────

/**
 * Whether this render can be served from the cached set. Everything else is
 * the live query, unchanged. See the module docblock for why each is live.
 */
export function canServeEventsFromCache(
  p: EventsListingParams,
  opts: { isCalendarView: boolean; includeVendorDays?: boolean }
): boolean {
  if (p.query) return false;
  if (p.myEvents === "true" || p.favorites === "true") return false;
  if (p.includePast === "true") return false;
  if (opts.isCalendarView && opts.includeVendorDays) return false;
  if (p.state && !/^[A-Za-z]{2}$/.test(p.state)) return false;
  return true;
}

/** Every upcoming public event, calendar-shaped, in date-asc/id order. */
export async function getCachedEventsUpcomingSet(
  db: ListingDb,
  kv: ReadThroughKv | null | undefined,
  now: Date = new Date()
): Promise<EventsListingCard[]> {
  const encoded = await kvReadThrough(
    kv,
    EVENTS_UPCOMING_SET_KEY,
    EVENTS_LISTING_CACHE_TTL_SECONDS,
    async () => {
      const { events: rows } = await loadEventsListingLive(
        db,
        {},
        { page: 1, limit: 0, isCalendarView: true, includeVendorDays: false, now }
      );
      return cacheRoundTrip(rows);
    }
  );
  return fromCacheable<EventsListingCard[]>(encoded);
}

/**
 * The ids, among upcoming public events, that a SQL-only predicate selects —
 * cached per `keySuffix`. Used for the predicates that are deliberately NOT
 * ported to JavaScript (state, the week/weekend occurrence test, `days`).
 */
export async function getCachedPredicateIds(
  db: ListingDb,
  kv: ReadThroughKv | null | undefined,
  keySuffix: string,
  predicate: SQL,
  now: Date
): Promise<string[]> {
  return kvReadThrough(
    kv,
    `${KEY_PREFIX}:ids:${keySuffix}`,
    EVENTS_LISTING_CACHE_TTL_SECONDS,
    async () => {
      const rows = await db
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            isPublicEventStatus(),
            isNotNull(events.startDate),
            upcomingEndPredicate(now),
            predicate
          )
        );
      return rows.map((r) => r.id);
    }
  );
}

/**
 * SQLite's built-in `lower()` folds ASCII only (no ICU on D1), and `LIKE` is
 * case-insensitive for ASCII only. JS `toLowerCase()` folds everything, so the
 * in-memory port folds ASCII only too — otherwise "É" would match "é" in
 * memory and not in SQL.
 */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** `instr(lower(col), needle.toLowerCase()) > 0` — containsCI. NULL col → no match. */
function containsCIMemory(col: string | null | undefined, needle: string): boolean {
  if (col === null || col === undefined) return false;
  return asciiLower(col).includes(needle.toLowerCase());
}

/** `col LIKE '%needle%'` for a needle with no wildcards. NULL col → NULL (not true). */
function likeContainsMemory(col: string, needle: string): boolean {
  return asciiLower(col).includes(asciiLower(needle));
}

/** SQLite BINARY collation = byte order of UTF-8 = code-point order. */
function compareBinary(a: string, b: string): number {
  if (a === b) return 0;
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/** SQLite orders NULL before every value ascending. */
function compareNullableNumber(a: number | null | undefined, b: number | null | undefined) {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an || bn) return an === bn ? 0 : an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Drizzle `timestamp` mode binds `Math.floor(ms / 1000)` seconds. */
function asStoredSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function sortRows(rows: EventsListingCard[], sort: ListingSort): EventsListingCard[] {
  const start = (e: EventsListingCard) => (e.startDate ? asStoredSeconds(e.startDate) : 9999999999);
  const cmp: Record<ListingSort, (a: EventsListingCard, b: EventsListingCard) => number> = {
    // COALESCE(start_date, 9999999999) ASC
    "date-asc": (a, b) => start(a) - start(b),
    // start_date DESC (NULLs last)
    "date-desc": (a, b) =>
      -compareNullableNumber(
        a.startDate ? asStoredSeconds(a.startDate) : null,
        b.startDate ? asStoredSeconds(b.startDate) : null
      ),
    "name-asc": (a, b) => compareBinary(a.name, b.name),
    "name-desc": (a, b) => -compareBinary(a.name, b.name),
    popular: (a, b) => -compareNullableNumber(a.viewCount, b.viewCount),
  };
  const primary = cmp[sort];
  // Then `events.id` ASC — the tiebreak the live query now carries.
  return [...rows].sort((a, b) => primary(a, b) || compareBinary(a.id, b.id));
}

/**
 * The cached-path answer for a render `canServeEventsFromCache` accepted:
 * the same `{ events, total }` the live query returns.
 */
export async function loadEventsListingCached(
  db: ListingDb,
  kv: ReadThroughKv | null | undefined,
  p: EventsListingParams,
  opts: Pick<EventsListingOptions, "page" | "limit" | "isCalendarView"> & { now?: Date }
): Promise<{ events: EventsListingCard[]; total: number }> {
  const now = opts.now ?? new Date();
  const set = await getCachedEventsUpcomingSet(db, kv, now);

  // SQL-only predicates → cached id sets, fetched in parallel.
  const idSets: Promise<string[]>[] = [];
  if (p.state) {
    const code = p.state.toUpperCase(); // two ASCII letters (canServeEventsFromCache)
    idSets.push(getCachedPredicateIds(db, kv, `state:${code}`, eventInStateWhere(code), now));
  }
  const whenEnd = whenWindowEnd(p.when, now);
  if (whenEnd && (p.when === "week" || p.when === "weekend")) {
    // Keyed on the day strings the predicate binds, so the key moves with the window.
    idSets.push(
      getCachedPredicateIds(
        db,
        kv,
        `when-occ:${utcDateStr(now)}:${utcDateStr(whenEnd)}`,
        hasOccurrenceInWindowOrUndated(now, whenEnd),
        now
      )
    );
  }
  const daysFilter: DaysFilter | null = parseDaysFilter(p.days);
  if (daysFilter) {
    const clipFrom = easternDateStr(now);
    idSets.push(
      getCachedPredicateIds(
        db,
        kv,
        `days:${daysFilter}:${clipFrom}`,
        daysFilterPredicate(daysFilter, clipFrom),
        now
      )
    );
  }
  const allowed = (await Promise.all(idSets)).map((ids) => new Set(ids));

  const whenEndSeconds = whenEnd ? asStoredSeconds(whenEnd) : null;
  const filtered = set.filter((e) => {
    for (const ids of allowed) if (!ids.has(e.id)) return false;
    // lte(start_date, whenEnd)
    if (whenEndSeconds !== null && !(e.startDate && asStoredSeconds(e.startDate) <= whenEndSeconds))
      return false;
    // containsCI(categories, category)
    if (p.category && !containsCIMemory(e.categories, p.category)) return false;
    // featured = 1
    if (p.featured === "true" && e.featured !== true) return false;
    // commercial_vendors_allowed IS NOT 0
    if (p.commercialVendors === "true" && e.commercialVendorsAllowed === false) return false;
    if (p.excludeFarmersMarkets === "true") {
      // (categories NOT LIKE … OR categories IS NULL) AND name NOT LIKE …
      const cats = e.categories;
      const catsOk =
        cats === null || cats === undefined || !likeContainsMemory(cats, "Farmers Market");
      if (!catsOk || likeContainsMemory(e.name, "Farmers Market")) return false;
    }
    // indoor_outdoor = ? / event_scale = ? (BINARY text equality)
    if (p.indoorOutdoor && e.indoorOutdoor !== p.indoorOutdoor) return false;
    if (p.scale && e.eventScale !== p.scale) return false;
    return true;
  });

  const sorted = sortRows(filtered, parseSort(p.sort));

  if (opts.isCalendarView) return { events: sorted, total: sorted.length };

  // A card/table render never carried `eventDayHours`; keep the payload as it was.
  const pageRows = pageSlice(sorted, opts.page, opts.limit).map((e) => {
    if (!("eventDayHours" in e)) return e;
    const { eventDayHours: _hours, ...rest } = e;
    return rest as EventsListingCard;
  });
  return { events: pageRows, total: sorted.length };
}

// ── Sidebar facets (categories, states) ─────────────────────────────────────

/** Every category on a public event, sorted. Was a whole-table scan per render. */
export async function getCachedEventCategories(
  db: ListingDb,
  kv: ReadThroughKv | null | undefined
): Promise<string[]> {
  return kvReadThrough(
    kv,
    `${KEY_PREFIX}:categories`,
    EVENTS_LISTING_CACHE_TTL_SECONDS,
    async () => {
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
    }
  );
}

/**
 * Active-venue states ∪ public events' state_code (so statewide-only events
 * with no venue still surface their state). Was two DISTINCT scans per render.
 */
export async function getCachedEventStates(
  db: ListingDb,
  kv: ReadThroughKv | null | undefined
): Promise<string[]> {
  return kvReadThrough(kv, `${KEY_PREFIX}:states`, EVENTS_LISTING_CACHE_TTL_SECONDS, async () => {
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
  });
}
