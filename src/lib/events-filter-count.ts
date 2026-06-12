import { and, eq, isNotNull, like, notLike, or, isNull, lte, count, sql } from "drizzle-orm";
import { events } from "@/lib/db/schema";
import { isPublicEventStatus } from "@/lib/event-status";
import { upcomingEndPredicate, whenWindowEnd } from "@/lib/event-dates";
import { sanitizeLikeInput } from "@/lib/utils";
import type { DrizzleD1Database } from "drizzle-orm/d1";

// Public filters that show up in /events?... URLs and could legitimately
// be crawled. User-scoped filters (myEvents, favorites) are excluded
// because they require auth and never appear in indexable URLs anyway.
const PUBLIC_FILTER_KEYS = [
  "query",
  "category",
  "state",
  "featured",
  "commercialVendors",
  "excludeFarmersMarkets",
  "indoorOutdoor",
  "scale",
  "includePast",
  "includeTBD",
  "when",
] as const;

type FilterableSearchParams = Partial<Record<(typeof PUBLIC_FILTER_KEYS)[number] | "page", string>>;

/**
 * Returns true when the request carries any public filter, OR is a
 * deep page beyond p1. /events with no params is "the canonical listing"
 * and never noindex'd; everything else is a filtered/paginated view that
 * should noindex when empty (soft-404 mitigation).
 */
export function hasPublicFilters(searchParams: FilterableSearchParams): boolean {
  for (const key of PUBLIC_FILTER_KEYS) {
    const value = searchParams[key];
    if (value && value.length > 0) return true;
  }
  const page = parseInt(searchParams.page || "1");
  if (page > 1) return true;
  return false;
}

/**
 * Counts events matching the public-only filter subset. Mirrors the
 * conditions in src/app/events/page.tsx:getEvents but skips the
 * user-scoped (myEvents/favorites) branches, since those are never
 * indexed. Used by /events generateMetadata to decide whether to emit
 * `robots: noindex,follow` on zero-result filtered pages.
 *
 * Intentionally not extracted from getEvents itself — getEvents accretes
 * additional conditions across many branches (auth, calendar view, etc.)
 * and refactoring it carries risk disproportionate to the noindex fix.
 * A small divergence here is acceptable: if we noindex a page that
 * *would* have had results under the full pipeline, the user can still
 * navigate to it from a UI link — only Google's crawler is affected.
 */
export async function countPublicFilteredEvents(
  db: DrizzleD1Database<Record<string, unknown>>,
  searchParams: FilterableSearchParams
): Promise<number> {
  const conditions = [isPublicEventStatus()];

  if (searchParams.includePast !== "true") {
    conditions.push(isNotNull(events.startDate));
    // A2 (Dev backlog 2026-06-05): 24h end-of-day grace per upcomingEndPredicate
    // — keep this in lockstep with src/app/events/page.tsx (same predicate).
    conditions.push(upcomingEndPredicate(new Date()));
  }

  // C2 P2 — keep the "when" date window in lockstep with src/app/events/page.tsx.
  const whenEnd = whenWindowEnd(searchParams.when);
  if (whenEnd) {
    conditions.push(lte(events.startDate, whenEnd));
  }

  if (searchParams.query) {
    const query = sanitizeLikeInput(searchParams.query.toLowerCase().trim());
    const searchTerm = `%${query}%`;
    conditions.push(
      or(
        sql`LOWER(${events.name}) LIKE ${searchTerm}`,
        sql`LOWER(${events.description}) LIKE ${searchTerm}`
      )!
    );
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

  if (searchParams.state) {
    conditions.push(eq(events.stateCode, searchParams.state));
  }

  const [row] = await db
    .select({ count: count() })
    .from(events)
    .where(and(...conditions));
  return row?.count ?? 0;
}
