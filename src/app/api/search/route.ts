export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, vendors, blogPosts } from "@/lib/db/schema";
import {
  and,
  or,
  gte,
  eq,
  inArray,
  isNull,
  sql,
  desc,
  type SQL,
  type AnyColumn,
} from "drizzle-orm";
import { isPublicEventStatus } from "@/lib/event-status";
import { withErrorHandler } from "@/lib/api-handler";
import { searchHelpArticles } from "@/lib/help-articles";
import { sanitizeLikeInput } from "@/lib/utils";
import { expandEventSearchQuery } from "@/lib/search/query-expansion";
import { levenshteinSimilarity } from "@takemetothefair/utils";
import { logError } from "@/lib/logger";
import {
  collectBrandParentIdsToLoad,
  groupVendorsForListing,
  type GroupableVendor,
} from "@/lib/vendor-listing-grouping";

// SEARCH1 (2026-06-09) — Cap query length at 100 chars. SQLite's LIKE-pattern
// complexity counter (limit ~50k) trips on long unanchored `%…%` patterns
// scanned against large text columns; before this cap, every keystroke past
// ~45 chars 500'd the whole route. The cap is enforced server-side and
// mirrored client-side as `maxLength` (defense in depth).
const MAX_QUERY_LENGTH = 100;

const EMPTY_RESPONSE = { events: [], venues: [], vendors: [], blogPosts: [], help: [] };

export const GET = withErrorHandler(async (request: Request) => {
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim();

  // Match the pre-existing `q.length < 2 → []` failure-closed convention.
  // Over-cap queries return empty rather than 4xx — there's no malicious
  // intent expected here, just a UX backstop. A scary banner mid-typing
  // would be worse than a temporarily-empty dropdown.
  if (!q || q.length < 2 || q.length > MAX_QUERY_LENGTH) {
    return NextResponse.json(EMPTY_RESPONSE);
  }

  const db = getCloudflareDb();
  // Escape LIKE metacharacters (`%`, `_`) before wrapping the user's input.
  // Without this, a query like `100%_off` was interpreted as wildcards
  // rather than literal text.
  const searchTerm = `%${sanitizeLikeInput(q)}%`;

  // OPE-281 — expand the query into structured match intent for the EVENTS
  // section: event-type synonyms (fair⇄market⇄festival⇄show), category mapping
  // ("arts and crafts" → Craft Fair/Art Show), and a trailing state token
  // ("blueberry connecticut" → term "blueberry" + state CT). The other sections
  // keep the plain substring match. If the query carries no distinctive text
  // (e.g. only a state), fall back to the raw name LIKE.
  const expanded = expandEventSearchQuery(q);
  const like = (col: AnyColumn, term: string) =>
    sql`LOWER(${col}) LIKE ${"%" + sanitizeLikeInput(term) + "%"}`;
  const nameGroupClauses = expanded.nameTermGroups
    .map((group) => or(...group.map((alt) => like(events.name, alt))))
    .filter((c): c is SQL => c !== undefined);
  const nameMatch = nameGroupClauses.length > 0 ? and(...nameGroupClauses) : undefined;
  const categoryMatch =
    expanded.categoryNames.length > 0
      ? or(...expanded.categoryNames.map((c) => like(events.categories, c.toLowerCase())))
      : undefined;
  const eventTextPredicate: SQL =
    nameMatch && categoryMatch
      ? (or(nameMatch, categoryMatch) as SQL)
      : (nameMatch ?? categoryMatch ?? sql`LOWER(${events.name}) LIKE LOWER(${searchTerm})`);
  const eventsWhere = and(
    isPublicEventStatus(),
    gte(events.endDate, new Date()),
    eventTextPredicate,
    ...(expanded.stateCode ? [sql`UPPER(${venues.state}) = ${expanded.stateCode}`] : [])
  );

  // Promise.allSettled (not Promise.all) so one failing section returns
  // empty for that section instead of 500-ing the whole response. Each
  // per-section failure logs to D1 at `warn` so we keep visibility on the
  // (now-graceful) degradation; previously these manifested as hard 500s
  // in `error_logs` under source=`api/search`.
  const [eventsSettled, venuesSettled, vendorsSettled, blogSettled] = await Promise.allSettled([
    db
      .select({
        name: events.name,
        slug: events.slug,
        startDate: events.startDate,
        endDate: events.endDate,
        venueName: venues.name,
        venueCity: venues.city,
        venueState: venues.state,
      })
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(eventsWhere)
      .orderBy(events.startDate)
      .limit(5),

    db
      .select({
        name: venues.name,
        slug: venues.slug,
        city: venues.city,
        state: venues.state,
      })
      .from(venues)
      .where(
        and(
          eq(venues.status, "ACTIVE"),
          sql`(LOWER(${venues.name}) LIKE LOWER(${searchTerm}) OR LOWER(${venues.city}) LIKE LOWER(${searchTerm}))`
        )
      )
      .orderBy(venues.name)
      .limit(5),

    db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        // EH2.1 — surface display_name so the client dropdown can honor
        // the brand override.
        displayName: vendors.displayName,
        slug: vendors.slug,
        vendorType: vendors.vendorType,
        // EH2.4 — hierarchy fields for the brand-parent search dedup
        // applied below. We over-fetch (LIMIT 15 instead of 5) so the
        // dedup leaves room for 5 distinct results in the dropdown.
        role: vendors.role,
        brandParentVendorId: vendors.brandParentVendorId,
        operatorParentVendorId: vendors.operatorParentVendorId,
        aliasOfVendorId: vendors.aliasOfVendorId,
        displayOverridePermitted: vendors.displayOverridePermitted,
        displayMode: vendors.displayMode,
        defaultChildDisplay: vendors.defaultChildDisplay,
      })
      .from(vendors)
      .where(
        sql`LOWER(${vendors.businessName}) LIKE LOWER(${searchTerm}) OR LOWER(COALESCE(${vendors.displayName}, '')) LIKE LOWER(${searchTerm})`
      )
      .orderBy(vendors.businessName)
      .limit(15),

    // SEARCH1 — Dropped `LOWER(blogPosts.body) LIKE …` from this WHERE.
    // The full-Markdown body column was the primary trigger for "LIKE
    // pattern too complex" failures on long queries. title + excerpt is
    // a smaller, denser search surface; FTS5 is the longer-term answer
    // (see plan §A "Out of scope") but a 1-line fix beats a migration.
    // COALESCE because some older posts have NULL excerpt.
    db
      .select({
        title: blogPosts.title,
        slug: blogPosts.slug,
        excerpt: blogPosts.excerpt,
      })
      .from(blogPosts)
      .where(
        and(
          eq(blogPosts.status, "PUBLISHED"),
          sql`(LOWER(${blogPosts.title}) LIKE LOWER(${searchTerm}) OR LOWER(COALESCE(${blogPosts.excerpt}, '')) LIKE LOWER(${searchTerm}))`
        )
      )
      .orderBy(desc(blogPosts.publishDate))
      .limit(5),
  ]);

  // Log per-section failures as `warn` (not `error`) — the route succeeded
  // overall and degraded gracefully. Real outages will show all 4 sections
  // failing simultaneously (operator can sum by section in /admin/logs).
  await Promise.all(
    (
      [
        [eventsSettled, "events"],
        [venuesSettled, "venues"],
        [vendorsSettled, "vendors"],
        [blogSettled, "blogPosts"],
      ] as const
    ).map(async ([settled, section]) => {
      if (settled.status === "rejected") {
        await logError(db, {
          message: `Search section "${section}" failed`,
          error: settled.reason,
          source: "api/search",
          request,
          context: { section, q },
          level: "warn",
        });
      }
    })
  );

  // Discriminated-union narrowing preserves the per-section query types
  // (the destructured `eventsSettled` is `PromiseSettledResult<T_events>`).
  const eventResults = eventsSettled.status === "fulfilled" ? eventsSettled.value : [];

  // OPE-281 — zero-result fuzzy fallback for misspellings ("mrshfeild" →
  // "Marshfield Fair"). Only fires when the structured match found nothing AND
  // the query carries a distinctive term, so the bounded name scan stays a rare
  // exception (matching the "zero-result is where we failed the user" signal).
  let finalEventResults = eventResults;
  const fuzzyTerms = expanded.coreTerms.filter((t) => t.length >= 5);
  if (eventResults.length === 0 && fuzzyTerms.length > 0) {
    try {
      const candidates = await db
        .select({
          name: events.name,
          slug: events.slug,
          startDate: events.startDate,
          endDate: events.endDate,
          venueName: venues.name,
          venueCity: venues.city,
          venueState: venues.state,
        })
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .where(
          and(
            isPublicEventStatus(),
            gte(events.endDate, new Date()),
            ...(expanded.stateCode ? [sql`UPPER(${venues.state}) = ${expanded.stateCode}`] : [])
          )
        )
        .orderBy(events.startDate)
        .limit(400);
      // 0.7 catches the audit's canonical "mrshfeild" → "marshfield" (exactly
      // 0.7 = 1 − 3/10). Restrict to coreTerms ≥ 5 chars so short tokens can't
      // fuzzily collide; safe because this runs only after an exact-match miss.
      const FUZZY_THRESHOLD = 0.7;
      finalEventResults = candidates
        .map((r) => {
          const nameWords = r.name.toLowerCase().split(/\s+/).filter(Boolean);
          let best = 0;
          for (const term of fuzzyTerms) {
            for (const w of nameWords) {
              const s = levenshteinSimilarity(term, w, FUZZY_THRESHOLD);
              if (s > best) best = s;
            }
          }
          return { r, best };
        })
        .filter((x) => x.best >= FUZZY_THRESHOLD)
        .sort((a, b) => b.best - a.best)
        .slice(0, 5)
        .map((x) => x.r);
    } catch (err) {
      await logError(db, {
        message: "Search fuzzy fallback failed",
        error: err,
        source: "api/search",
        request,
        context: { q },
        level: "warn",
      });
    }
  }

  const venueResults = venuesSettled.status === "fulfilled" ? venuesSettled.value : [];
  const vendorResults = vendorsSettled.status === "fulfilled" ? vendorsSettled.value : [];
  const blogResults = blogSettled.status === "fulfilled" ? blogSettled.value : [];

  // EH2.4 — apply the listing brand-parent grouper to dedup the vendor
  // search dropdown the same way the /vendors listing does. Reuses the
  // same pure helper so behavior stays in lock-step. The grouper drops
  // self-mode brand hubs from the result set (they're noindex,follow
  // surfaces — irrelevant in search), and collapses brand-parent-mode
  // brands' offices into a single row.
  const matchedById = new Map(vendorResults.map((v) => [v.id, v]));
  const matchedAsGroupable: GroupableVendor[] = vendorResults.map((v) => ({
    id: v.id,
    role: v.role,
    brandParentVendorId: v.brandParentVendorId,
    operatorParentVendorId: v.operatorParentVendorId,
    aliasOfVendorId: v.aliasOfVendorId,
    displayOverridePermitted: v.displayOverridePermitted,
    displayMode: v.displayMode,
    defaultChildDisplay: v.defaultChildDisplay,
  }));
  // Batch-fetch brand parent rows referenced by office matches but not
  // in the match set themselves (caller searched for the office only).
  // Search dropdowns are time-sensitive, so we only pay this extra query
  // when there's at least one office match.
  const brandIdsToLoad = collectBrandParentIdsToLoad(matchedAsGroupable);
  const missingBrandIds = brandIdsToLoad.filter((id) => !matchedById.has(id));
  const extraBrandRows =
    missingBrandIds.length > 0
      ? await db
          .select({
            id: vendors.id,
            businessName: vendors.businessName,
            displayName: vendors.displayName,
            slug: vendors.slug,
            vendorType: vendors.vendorType,
            role: vendors.role,
            brandParentVendorId: vendors.brandParentVendorId,
            operatorParentVendorId: vendors.operatorParentVendorId,
            aliasOfVendorId: vendors.aliasOfVendorId,
            displayOverridePermitted: vendors.displayOverridePermitted,
            displayMode: vendors.displayMode,
            defaultChildDisplay: vendors.defaultChildDisplay,
          })
          .from(vendors)
          .where(and(inArray(vendors.id, missingBrandIds), isNull(vendors.deletedAt)))
      : [];
  for (const r of extraBrandRows) matchedById.set(r.id, r);
  const brandParentsForGrouping = new Map<string, GroupableVendor>();
  for (const id of brandIdsToLoad) {
    const row = matchedById.get(id);
    if (!row) continue;
    brandParentsForGrouping.set(id, {
      id: row.id,
      role: row.role,
      brandParentVendorId: row.brandParentVendorId,
      operatorParentVendorId: row.operatorParentVendorId,
      aliasOfVendorId: row.aliasOfVendorId,
      displayOverridePermitted: row.displayOverridePermitted,
      displayMode: row.displayMode,
      defaultChildDisplay: row.defaultChildDisplay,
    });
  }
  // Also register any NATIONAL row that's a brand_parent-mode brand and
  // is directly in the match set, so the grouper can decide whether to
  // promote it to a collapsed card.
  for (const v of vendorResults) {
    if (v.role === "NATIONAL") {
      brandParentsForGrouping.set(v.id, {
        id: v.id,
        role: v.role,
        brandParentVendorId: v.brandParentVendorId,
        operatorParentVendorId: v.operatorParentVendorId,
        aliasOfVendorId: v.aliasOfVendorId,
        displayOverridePermitted: v.displayOverridePermitted,
        displayMode: v.displayMode,
        defaultChildDisplay: v.defaultChildDisplay,
      });
    }
  }
  const cards = groupVendorsForListing({
    matchedVendors: matchedAsGroupable,
    brandParentsById: brandParentsForGrouping,
    // No officesByBrandId — the search dropdown doesn't aggregate events,
    // so the grouper's aggregatedEventVendorIds field is unused here.
    officesByBrandId: new Map(),
  });
  // Slice to 5 (the dropdown's slot count) AFTER dedup so brand collapse
  // doesn't shrink the result count below what users expect.
  const dedupedVendors = cards
    .slice(0, 5)
    .map((card) => {
      const row = matchedById.get(card.vendorId);
      if (!row) return null;
      return {
        businessName: row.businessName,
        displayName: row.displayName,
        slug: row.slug,
        vendorType: row.vendorType,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Help articles are a static in-memory TS array (HELP_ARTICLES), not D1, so
  // this is a synchronous substring match — no query, no Promise.allSettled slot.
  const helpResults = searchHelpArticles(q);

  return NextResponse.json({
    events: finalEventResults.map((e) => ({
      name: e.name,
      slug: e.slug,
      startDate: e.startDate,
      endDate: e.endDate,
      venue: e.venueName ? { name: e.venueName, city: e.venueCity, state: e.venueState } : null,
    })),
    venues: venueResults,
    vendors: dedupedVendors,
    blogPosts: blogResults,
    help: helpResults,
  });
}, "api/search");
