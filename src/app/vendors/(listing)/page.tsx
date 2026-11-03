import type { Metadata } from "next";
import { isD1PlatformFault } from "@/lib/db/degraded";
import { DegradedPanel } from "@/components/layout/degraded-panel";
import Link from "next/link";
import { Search, X, Heart, Calendar } from "lucide-react";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, users } from "@/lib/db/schema";
import { eq, and, isNotNull, isNull, sql } from "drizzle-orm";
import { loadVendorListingPage } from "@/lib/vendors/listing-page";
import { auth } from "@/lib/auth";
import { VendorsView } from "@/components/vendors/vendors-view";
import { logError } from "@/lib/logger";
import { ItemListSchema } from "@/components/seo/ItemListSchema";
import { ItemListTracker } from "@/components/analytics/ItemListTracker";
import { NewsletterSignupBlock } from "@/components/newsletter/newsletter-signup-block";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { Pagination } from "@/components/ui/pagination";
import { MobileFilterDrawer } from "@/components/ui/mobile-filter-drawer";
import {
  FeaturedVendorsSection,
  type FeaturedVendor,
} from "@/components/vendors/FeaturedVendorsSection";
import { withD1ReadLogged } from "@/lib/db/d1-resilience";

const PAGE_SIZE = 50;

export const revalidate = 3600; // Cache for 1 hour

export const metadata: Metadata = {
  title: "Fair & Festival Vendors | Meet Me at the Fair",
  description:
    "Meet the artisans, food vendors, and businesses participating in fairs and festivals.",
  alternates: { canonical: "https://meetmeatthefair.com/vendors" },
  openGraph: {
    title: "Fair & Festival Vendors | Meet Me at the Fair",
    description:
      "Meet the artisans, food vendors, and businesses participating in fairs and festivals.",
    url: "https://meetmeatthefair.com/vendors",
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
    title: "Fair & Festival Vendors | Meet Me at the Fair",
    description:
      "Meet the artisans, food vendors, and businesses participating in fairs and festivals.",
    images: ["https://meetmeatthefair.com/og-default.png"],
  },
};

// Helper to build query strings while preserving existing params
function buildQueryString(params: Record<string, string | undefined>): string {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) searchParams.set(key, value);
  });
  const str = searchParams.toString();
  return str ? `?${str}` : "";
}

interface SearchParams {
  type?: string;
  favorites?: string;
  hasEvents?: string;
  q?: string;
  page?: string;
}

/**
 * OPE-790 — one jittered retry on a Cloudflare-side D1 blip before the failure
 * reaches the user. Wraps the fetcher rather than its body so every call site
 * inherits it, and so the diagnostic catch inside stays exactly as OPE-548 left
 * it. Only a PLATFORM fault is retried; a query defect fails the same way twice.
 */
function getVendors(searchParams: SearchParams, currentPage: number, favoriteUserId?: string) {
  return withD1ReadLogged("app/vendors/page.tsx:getVendors", () =>
    getVendorsOnce(searchParams, currentPage, favoriteUserId)
  );
}

/**
 * OPE-1395 (IDX1) — loads ONE page of cards. The match set is read as a narrow
 * projection and full rows + upcoming events are fetched for this page's cards
 * only; see src/lib/vendors/listing-page.ts for why the card list (not the SQL
 * row set) is what gets paginated.
 */
async function getVendorsOnce(
  searchParams: SearchParams,
  currentPage: number,
  favoriteUserId?: string
) {
  const db = getCloudflareDb();

  try {
    if (searchParams.favorites === "true" && !favoriteUserId) {
      return { vendors: [], totalCount: 0 };
    }
    return await loadVendorListingPage(
      db,
      {
        type: searchParams.type,
        q: searchParams.q,
        hasEvents: searchParams.hasEvents,
        favoriteUserId: searchParams.favorites === "true" ? favoriteUserId : undefined,
      },
      { number: currentPage, size: PAGE_SIZE }
    );
  } catch (e) {
    await logError(db, {
      message: "Error fetching vendors",
      error: e,
      source: "app/vendors/page.tsx:getVendors",
      context: { searchParams },
    });
    // K2 (2026-06-06): throw FetchError so error.tsx renders + HTTP 500
    // bubbles to the edge. Mirrors REL1' §1 pattern in events/page.tsx.
    const { FetchError } = await import("@/lib/errors/fetch-error");
    throw new FetchError("app/vendors/page.tsx:getVendors", e);
  }
}

/**
 * OPE-790 — one jittered retry on a Cloudflare-side D1 blip before the failure
 * reaches the user. Wraps the fetcher rather than its body so every call site
 * inherits it, and so the diagnostic catch inside stays exactly as OPE-548 left
 * it. Only a PLATFORM fault is retried; a query defect fails the same way twice.
 */
function getVendorTypes() {
  return withD1ReadLogged("app/vendors/page.tsx:getVendorTypes", () => getVendorTypesOnce());
}

async function getVendorTypesOnce() {
  const db = getCloudflareDb();

  try {
    const results = await db
      .selectDistinct({ vendorType: vendors.vendorType })
      .from(vendors)
      .where(isNotNull(vendors.vendorType));

    return results
      .map((v) => v.vendorType)
      .filter((t): t is string => t !== null)
      .sort();
  } catch (e) {
    await logError(db, {
      message: "Error fetching vendor types",
      error: e,
      source: "app/vendors/page.tsx:getVendorTypes",
    });
    const { FetchError } = await import("@/lib/errors/fetch-error");
    throw new FetchError("app/vendors/page.tsx:getVendorTypes", e);
  }
}

/**
 * Pull all Enhanced-Profile vendors (optionally filtered to a category) for
 * the Featured Vendors section. The component handles the daily rotation
 * and caps to 6; we hand over the full eligible set so the rotation can
 * shuffle across the full pool, not just whatever fits in 6 slots.
 */
/**
 * OPE-790 — one jittered retry on a Cloudflare-side D1 blip before the failure
 * reaches the user. Wraps the fetcher rather than its body so every call site
 * inherits it, and so the diagnostic catch inside stays exactly as OPE-548 left
 * it. Only a PLATFORM fault is retried; a query defect fails the same way twice.
 */
function getFeaturedVendors(typeFilter?: string) {
  return withD1ReadLogged("app/vendors/page.tsx:getFeaturedVendors", () =>
    getFeaturedVendorsOnce(typeFilter)
  );
}

async function getFeaturedVendorsOnce(typeFilter?: string): Promise<FeaturedVendor[]> {
  const db = getCloudflareDb();
  const conditions: (ReturnType<typeof eq> | ReturnType<typeof isNull>)[] = [
    eq(vendors.enhancedProfile, true),
    isNull(vendors.deletedAt),
  ];
  if (typeFilter) conditions.push(eq(vendors.vendorType, typeFilter));

  try {
    const rows = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        slug: vendors.slug,
        vendorType: vendors.vendorType,
        city: vendors.city,
        state: vendors.state,
        logoUrl: vendors.logoUrl,
        featuredPriority: vendors.featuredPriority,
        claimed: vendors.claimed,
        // OPE-238 — the ownership badge needs the OWNER's verification state,
        // not the claim flag alone. LEFT JOIN so a listing with no owner row
        // still returns; `ownerEmailVerified` is then null and the badge is
        // correctly withheld.
        ownerEmailVerified: sql<boolean>`${users.emailVerified} IS NOT NULL`,
        enhancedProfile: vendors.enhancedProfile,
        verifiedPro: vendors.verifiedPro,
      })
      .from(vendors)
      .leftJoin(users, eq(vendors.userId, users.id))
      .where(and(...conditions));
    return rows;
  } catch (e) {
    await logError(db, {
      message: "Error fetching featured vendors",
      error: e,
      source: "app/vendors/page.tsx:getFeaturedVendors",
    });
    const { FetchError } = await import("@/lib/errors/fetch-error");
    throw new FetchError("app/vendors/page.tsx:getFeaturedVendors", e);
  }
}

export const dynamic = "force-dynamic";

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const session = await auth();
  const isLoggedIn = !!session?.user?.id;

  const favoriteUserId = isLoggedIn && params.favorites === "true" ? session.user.id : undefined;
  const currentPage = Math.max(1, parseInt(params.page ?? "1", 10) || 1);

  let loaded: [
    Awaited<ReturnType<typeof getVendors>>,
    Awaited<ReturnType<typeof getVendorTypes>>,
    Awaited<ReturnType<typeof getFeaturedVendors>>,
  ];
  try {
    loaded = await Promise.all([
      getVendors(params, currentPage, favoriteUserId),
      getVendorTypes(),
      getFeaturedVendors(params.type),
    ]);
  } catch (e) {
    // OPE-790 rework (John, 10-04) — an honest degraded panel, not the error
    // boundary, when a D1 platform blip survives the retry. Our own query
    // defects still throw.
    if (isD1PlatformFault(e)) return <DegradedPanel what="vendors" retryHref="/vendors" />;
    throw e;
  }
  const [{ vendors: pageVendors, totalCount }, vendorTypes, featuredVendors] = loaded;

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const hasFilters = params.type || params.q || params.favorites || params.hasEvents;
  const showingFavorites = params.favorites === "true";
  const showingWithEvents = params.hasEvents === "true";

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Vendors", url: "https://meetmeatthefair.com/vendors" },
        ]}
      />
      <ItemListSchema
        name="Fair & Festival Vendors"
        description="Artisans, food vendors, and businesses at fairs and festivals"
        items={pageVendors.map((v) => ({
          name: v.businessName,
          url: `https://meetmeatthefair.com/vendors/${v.slug}`,
          image: v.logoUrl,
        }))}
        totalCount={totalCount}
        positionStart={(currentPage - 1) * PAGE_SIZE + 1}
        asCollectionPage
        pageUrl="https://meetmeatthefair.com/vendors"
      />
      <ItemListTracker
        listName={params.q ? "vendors_search_results" : "vendors_browse"}
        hrefPrefix="/vendors"
        items={pageVendors.map((v) => ({
          id: v.id,
          slug: v.slug,
          name: v.displayName ?? v.businessName,
        }))}
      />
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-foreground">Vendor Directory</h1>
        <p className="mt-2 text-muted-foreground">
          Meet the artisans, food vendors, and businesses at our events
          {totalCount > 0 && (
            <span className="ml-1 text-muted-foreground">
              ({totalCount.toLocaleString()} {totalCount === 1 ? "vendor" : "vendors"})
            </span>
          )}
        </p>
        {/* OPE-40 — crawlable path to every vendor (A–Z / by state), so detail
            pages are reachable without deep ?page=N pagination. */}
        <p className="mt-3">
          <Link href="/vendors/browse" className="font-medium text-navy hover:underline">
            Browse all vendors A–Z or by state →
          </Link>
        </p>
      </div>

      {/* OPE-1209 — the vendor newsletter, primary on the vendor directory.
          Before this the only signup here was the footer's attendee form, so
          an exhibitor who subscribed from this page joined the weekend list.
          The footer's form stays, labelled with its own name. */}
      <NewsletterSignupBlock source="vendors-directory" audience="vendor" />

      <FeaturedVendorsSection vendors={featuredVendors} />

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        <aside className="lg:col-span-1">
          <MobileFilterDrawer>
            <div className="bg-stone-50 p-5 rounded-xl border border-stone-100 space-y-6 lg:sticky lg:top-24">
              <h2 className="text-base font-semibold text-stone-900 pb-2 border-b border-stone-100">
                Filter vendors
              </h2>
              {/* Search */}
              <div>
                <h3 className="font-medium text-stone-900 mb-3">Search</h3>
                <form method="GET" action="/vendors">
                  {params.type && <input type="hidden" name="type" value={params.type} />}
                  {params.hasEvents && (
                    <input type="hidden" name="hasEvents" value={params.hasEvents} />
                  )}
                  {params.favorites && (
                    <input type="hidden" name="favorites" value={params.favorites} />
                  )}
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input
                      type="text"
                      name="q"
                      defaultValue={params.q || ""}
                      placeholder="Search vendors..."
                      className="w-full pl-10 pr-4 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-royal focus:border-royal"
                    />
                  </div>
                </form>
              </div>

              {/* Type Filter */}
              <div>
                <h3 className="font-medium text-foreground mb-3">Filter by Type</h3>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  <Link
                    href={`/vendors${buildQueryString({ q: params.q, hasEvents: params.hasEvents, favorites: params.favorites })}`}
                    className={`block px-3 py-2 rounded-lg text-sm ${
                      !params.type
                        ? "bg-amber-light text-amber-bg-fg font-medium"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    All Types
                  </Link>
                  {vendorTypes.map((type) => (
                    <Link
                      key={type}
                      href={`/vendors${buildQueryString({ type, q: params.q, hasEvents: params.hasEvents, favorites: params.favorites })}`}
                      className={`block px-3 py-2 rounded-lg text-sm ${
                        params.type === type
                          ? "bg-amber-light text-amber-bg-fg font-medium"
                          : "text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {type}
                    </Link>
                  ))}
                </div>
              </div>

              {/* Has Events Filter */}
              <div>
                <h3 className="font-medium text-foreground mb-3">Events</h3>
                {showingWithEvents ? (
                  <Link
                    href={`/vendors${buildQueryString({ type: params.type, q: params.q, favorites: params.favorites })}`}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-green-50 text-green-700 font-medium"
                  >
                    <Calendar className="w-4 h-4" />
                    With Upcoming Events
                  </Link>
                ) : (
                  <Link
                    href={`/vendors${buildQueryString({ type: params.type, q: params.q, hasEvents: "true", favorites: params.favorites })}`}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-muted"
                  >
                    <Calendar className="w-4 h-4" />
                    With Upcoming Events
                  </Link>
                )}
              </div>

              {/* Favorites Filter */}
              {isLoggedIn && (
                <div>
                  <h3 className="font-medium text-foreground mb-3">Favorites</h3>
                  {showingFavorites ? (
                    <Link
                      href={`/vendors${buildQueryString({ type: params.type, q: params.q, hasEvents: params.hasEvents })}`}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-pink-50 text-pink-700 font-medium"
                    >
                      <Heart className="w-4 h-4 fill-current" />
                      Showing Favorites
                    </Link>
                  ) : (
                    <Link
                      href={`/vendors${buildQueryString({ type: params.type, q: params.q, hasEvents: params.hasEvents, favorites: "true" })}`}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-muted"
                    >
                      <Heart className="w-4 h-4" />
                      My Favorites
                    </Link>
                  )}
                </div>
              )}

              {/* Clear Filters */}
              {hasFilters && (
                <Link
                  href="/vendors"
                  className="flex items-center justify-center gap-2 w-full px-4 py-2 text-sm font-medium text-foreground bg-muted hover:bg-muted rounded-lg transition-colors"
                >
                  <X className="w-4 h-4" />
                  Clear Filters
                </Link>
              )}
            </div>
          </MobileFilterDrawer>
        </aside>

        <main className="lg:col-span-3">
          <VendorsView
            vendors={pageVendors}
            emptyMessage={
              showingFavorites
                ? "You haven't favorited any vendors yet."
                : hasFilters
                  ? "No vendors found matching your criteria."
                  : "No vendors available at this time."
            }
          />
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            basePath="/vendors"
            searchParams={{
              type: params.type,
              favorites: params.favorites,
              hasEvents: params.hasEvents,
              q: params.q,
            }}
          />
        </main>
      </div>
    </div>
  );
}
