import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { Calendar, MapPin, Store, FileText, HelpCircle, Search } from "lucide-react";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, vendors, blogPosts, users } from "@/lib/db/schema";
import { and, eq, sql, desc, inArray, isNull } from "drizzle-orm";
import { isPublicEventStatus } from "@/lib/event-status";
import {
  collectBrandParentIdsToLoad,
  groupVendorsForListing,
  type GroupableVendor,
} from "@/lib/vendor-listing-grouping";
import { upcomingEndPredicate } from "@/lib/event-dates";
import { formatDateRange, sanitizeLikeInput } from "@/lib/utils";
import { formatDateMedium } from "@/lib/datetime";
import { Card } from "@/components/ui/card";
import { extractFirstImage } from "@/lib/markdown-utils";
import { searchHelpArticles } from "@/lib/help-articles";
import { logError } from "@/lib/logger";
import { SearchResultsTracker } from "@/components/search/SearchResultsTracker";

export const metadata: Metadata = {
  title: "Search Results | Meet Me at the Fair",
  robots: { index: false },
};

interface SearchPageProps {
  // OPE-172 — `query` is an alias for `q` (homepage hero + bookmarked
  // /events?query= links); `state` is the optional NE region filter.
  searchParams: Promise<{ q?: string; query?: string; state?: string }>;
}

export const dynamic = "force-dynamic";

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const params = await searchParams;
  const q = (params.q ?? params.query)?.trim() || "";
  // OPE-172 — optional region filter (events only; vendors travel across states).
  const stateCode = params.state?.trim().toUpperCase();
  const stateFilter =
    stateCode && /^[A-Z]{2}$/.test(stateCode) ? eq(events.stateCode, stateCode) : undefined;

  if (!q || q.length < 2) {
    return (
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16 text-center">
        <Search className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
        <h1 className="text-2xl font-bold text-navy mb-2">Search</h1>
        <p className="text-muted-foreground">Enter at least 2 characters to search.</p>
      </div>
    );
  }

  const db = getCloudflareDb();
  // SEARCH1-class hardening (mirror of /api/search, 2026-06-13): cap the query
  // length and escape LIKE metacharacters before building the pattern. An
  // unanchored `%…%` over very long input trips SQLite's pattern-complexity
  // limit — especially against large text columns — and 500s the whole page.
  const MAX_QUERY_LENGTH = 100;
  const searchTerm = `%${sanitizeLikeInput(q.slice(0, MAX_QUERY_LENGTH))}%`;

  // Promise.allSettled (not Promise.all) so one failing section degrades to
  // empty for that section instead of 500-ing the entire page.
  const [eventsSettled, venuesSettled, vendorsSettled, blogSettled] = await Promise.allSettled([
    db
      .select({
        name: events.name,
        slug: events.slug,
        startDate: events.startDate,
        endDate: events.endDate,
        imageUrl: events.imageUrl,
        categories: events.categories,
      })
      .from(events)
      .where(
        and(
          isPublicEventStatus(),
          // A2 (Dev backlog 2026-06-05): 24h end-of-day grace per upcomingEndPredicate.
          upcomingEndPredicate(new Date()),
          sql`(LOWER(${events.name}) LIKE LOWER(${searchTerm}) OR LOWER(${events.description}) LIKE LOWER(${searchTerm}))`,
          // OPE-172 — honor the homepage region selector (undefined = all NE).
          stateFilter
        )
      )
      .orderBy(events.startDate)
      .limit(12),

    db
      .select({
        name: venues.name,
        slug: venues.slug,
        city: venues.city,
        state: venues.state,
        imageUrl: venues.imageUrl,
      })
      .from(venues)
      .where(
        and(
          eq(venues.status, "ACTIVE"),
          sql`(LOWER(${venues.name}) LIKE LOWER(${searchTerm}) OR LOWER(${venues.city}) LIKE LOWER(${searchTerm}))`
        )
      )
      .orderBy(venues.name)
      .limit(12),

    db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        // EH2.1 — surface display_name so the result card can render the
        // brand surface (e.g. "LeafFilter" not "LeafFilter North LLC").
        displayName: vendors.displayName,
        slug: vendors.slug,
        vendorType: vendors.vendorType,
        logoUrl: vendors.logoUrl,
        // EH2-A6 (2026-06-13) — hierarchy fields for the brand-parent dedup
        // applied below, mirroring /api/search. Over-fetch (15) so the dedup
        // leaves room for ~12 distinct cards.
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
        // Match against either business_name OR display_name OR description
        // so brand-name searches surface a row even when only the override
        // matches.
        sql`(LOWER(${vendors.businessName}) LIKE LOWER(${searchTerm}) OR LOWER(COALESCE(${vendors.displayName}, '')) LIKE LOWER(${searchTerm}) OR LOWER(${vendors.description}) LIKE LOWER(${searchTerm}))`
      )
      .orderBy(vendors.businessName)
      .limit(15),

    db
      .select({
        title: blogPosts.title,
        slug: blogPosts.slug,
        excerpt: blogPosts.excerpt,
        body: blogPosts.body,
        featuredImageUrl: blogPosts.featuredImageUrl,
        publishDate: blogPosts.publishDate,
        authorName: users.name,
      })
      .from(blogPosts)
      .leftJoin(users, eq(blogPosts.authorId, users.id))
      .where(
        and(
          eq(blogPosts.status, "PUBLISHED"),
          // SEARCH1: match title + excerpt, NOT the full-markdown body — the
          // body LIKE was the pattern-complexity trigger. body is still
          // SELECTed above for the card thumbnail (extractFirstImage), just
          // no longer matched against. COALESCE because some posts have NULL excerpt.
          sql`(LOWER(${blogPosts.title}) LIKE LOWER(${searchTerm}) OR LOWER(COALESCE(${blogPosts.excerpt}, '')) LIKE LOWER(${searchTerm}))`
        )
      )
      .orderBy(desc(blogPosts.publishDate))
      .limit(12),
  ]);

  // Log any per-section failure as `warn` (the page still rendered), then fall
  // back to empty for that section — mirrors /api/search's degradation.
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
          message: `Search page section "${section}" failed`,
          error: settled.reason,
          source: "app/search/page",
          context: { section, q },
          level: "warn",
        });
      }
    })
  );

  const eventResults = eventsSettled.status === "fulfilled" ? eventsSettled.value : [];
  const venueResults = venuesSettled.status === "fulfilled" ? venuesSettled.value : [];
  const vendorMatches = vendorsSettled.status === "fulfilled" ? vendorsSettled.value : [];
  const blogResults = blogSettled.status === "fulfilled" ? blogSettled.value : [];

  // EH2-A6 (2026-06-13) — dedup the vendor results by brand-parent group, the
  // same way /api/search and the /vendors listing do, so `/search?q=leaf`
  // returns ONE LeafFilter card (the brand hub) instead of the hub plus each
  // of its offices. The grouper also drops self-mode brand hubs (noindex,
  // follow surfaces — irrelevant in search). Reuses the shared pure helper so
  // all three surfaces stay in lock-step.
  const matchedById = new Map(vendorMatches.map((v) => [v.id, v]));
  const matchedAsGroupable: GroupableVendor[] = vendorMatches.map((v) => ({
    id: v.id,
    role: v.role,
    brandParentVendorId: v.brandParentVendorId,
    operatorParentVendorId: v.operatorParentVendorId,
    aliasOfVendorId: v.aliasOfVendorId,
    displayOverridePermitted: v.displayOverridePermitted,
    displayMode: v.displayMode,
    defaultChildDisplay: v.defaultChildDisplay,
  }));
  // Batch-fetch brand parents referenced by office matches but not in the match
  // set (caller searched only the office). Only paid when an office matched.
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
            logoUrl: vendors.logoUrl,
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
  // Register any NATIONAL row directly in the match set so the grouper can
  // decide whether to promote it to a collapsed brand card.
  for (const v of vendorMatches) {
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
  const vendorCards = groupVendorsForListing({
    matchedVendors: matchedAsGroupable,
    brandParentsById: brandParentsForGrouping,
    officesByBrandId: new Map(),
  });
  const vendorResults = vendorCards
    .slice(0, 12)
    .map((card) => {
      const row = matchedById.get(card.vendorId);
      if (!row) return null;
      return {
        businessName: row.businessName,
        displayName: row.displayName,
        slug: row.slug,
        vendorType: row.vendorType,
        logoUrl: row.logoUrl,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Help articles are a static in-memory TS array (HELP_ARTICLES), not D1, so
  // this is a synchronous substring match — no query, no allSettled slot.
  const helpResults = searchHelpArticles(q, 12);

  const totalResults =
    eventResults.length +
    venueResults.length +
    vendorResults.length +
    blogResults.length +
    helpResults.length;

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      {/* OPE-248 — emit view_search_results WITH results_count (incl. 0) from
          this page. Without it the only event for a /search view is GA4's
          Enhanced Measurement site-search auto-event, which carries
          search_term but never results_count — so zero-result queries were
          undetectable. This is a Server Component, hence the client child. */}
      <SearchResultsTracker query={q} resultsCount={totalResults} />
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-navy">Search Results</h1>
        <p className="mt-2 text-muted-foreground">
          {totalResults === 0
            ? `No results found for "${q}"`
            : `Found ${totalResults} result${totalResults !== 1 ? "s" : ""} for "${q}"`}
        </p>
      </div>

      {totalResults === 0 && (
        <div className="text-center py-12">
          <Search className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">
            Try a different search term or browse by category.
          </p>
          <div className="flex justify-center gap-4 mt-6">
            <Link href="/events" className="text-royal hover:underline">
              Browse Events
            </Link>
            <Link href="/venues" className="text-royal hover:underline">
              Browse Venues
            </Link>
            <Link href="/vendors" className="text-royal hover:underline">
              Browse Vendors
            </Link>
            <Link href="/blog" className="text-royal hover:underline">
              Browse Blog
            </Link>
          </div>
        </div>
      )}

      <div className="space-y-10">
        {/* Events */}
        {eventResults.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-4">
              <Calendar className="w-5 h-5 text-amber-fg" />
              <h2 className="text-xl font-semibold text-navy">Events ({eventResults.length})</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {eventResults.map((event) => (
                <Link key={event.slug} href={`/events/${event.slug}`}>
                  <Card className="p-4 hover:shadow-md transition-shadow h-full">
                    <h3 className="font-medium text-navy">{event.name}</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      {formatDateRange(event.startDate, event.endDate)}
                    </p>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Blog Posts */}
        {blogResults.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-4">
              <FileText className="w-5 h-5 text-purple-600" />
              <h2 className="text-xl font-semibold text-navy">Blog Posts ({blogResults.length})</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {blogResults.map((post) => {
                const imageUrl = post.featuredImageUrl || extractFirstImage(post.body);
                return (
                  <Link key={post.slug} href={`/blog/${post.slug}`}>
                    <Card className="hover:shadow-md transition-shadow h-full overflow-hidden">
                      {imageUrl && (
                        <div className="aspect-video relative bg-muted">
                          <Image
                            src={imageUrl}
                            alt={post.title}
                            fill
                            sizes="(max-width: 768px) 100vw, 33vw"
                            className="object-cover"
                          />
                        </div>
                      )}
                      <div className="p-4">
                        <h3 className="font-medium text-navy">{post.title}</h3>
                        {post.excerpt && (
                          <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                            {post.excerpt}
                          </p>
                        )}
                        <div className="flex items-center gap-3 text-xs text-muted-foreground mt-2">
                          {post.publishDate && <span>{formatDateMedium(post.publishDate)}</span>}
                          {post.authorName && <span>{post.authorName}</span>}
                        </div>
                      </div>
                    </Card>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {/* Venues */}
        {venueResults.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-4">
              <MapPin className="w-5 h-5 text-royal" />
              <h2 className="text-xl font-semibold text-navy">Venues ({venueResults.length})</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {venueResults.map((venue) => (
                <Link key={venue.slug} href={`/venues/${venue.slug}`}>
                  <Card className="p-4 hover:shadow-md transition-shadow h-full">
                    <h3 className="font-medium text-navy">{venue.name}</h3>
                    {(venue.city || venue.state) && (
                      <p className="text-sm text-muted-foreground mt-1">
                        {[venue.city, venue.state].filter(Boolean).join(", ")}
                      </p>
                    )}
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Vendors */}
        {vendorResults.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-4">
              <Store className="w-5 h-5 text-green-600" />
              <h2 className="text-xl font-semibold text-navy">Vendors ({vendorResults.length})</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {vendorResults.map((vendor) => (
                <Link key={vendor.slug} href={`/vendors/${vendor.slug}`}>
                  <Card className="p-4 hover:shadow-md transition-shadow h-full">
                    <h3 className="font-medium text-navy">
                      {vendor.displayName ?? vendor.businessName}
                    </h3>
                    {vendor.vendorType && (
                      <p className="text-sm text-muted-foreground mt-1">{vendor.vendorType}</p>
                    )}
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Help */}
        {helpResults.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-4">
              <HelpCircle className="w-5 h-5 text-royal" />
              <h2 className="text-xl font-semibold text-navy">Help ({helpResults.length})</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {helpResults.map((article) => (
                <Link key={article.slug} href={`/help/${article.slug}`}>
                  <Card className="p-4 hover:shadow-md transition-shadow h-full">
                    <h3 className="font-medium text-navy">{article.title}</h3>
                    <p className="text-sm text-muted-foreground mt-1">{article.category}</p>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
