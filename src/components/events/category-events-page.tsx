import Link from "next/link";
import { Tag } from "lucide-react";
import { EventsView } from "@/components/events/events-view";
import { getCloudflareDb, getCloudflareRateLimitKv } from "@/lib/cloudflare";
import {
  countCategoryEvents,
  getCachedCategoryUpcomingSet,
  loadCategoryEventCards,
} from "@/lib/events/listing-family-cache";
import { pageSlice } from "@/lib/events/state-listing-cache";
import { ItemListSchema } from "@/components/seo/ItemListSchema";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";

export const CATEGORY_MAP: Record<
  string,
  { label: string; category: string; description: string }
> = {
  fairs: {
    label: "Fairs",
    category: "Fair",
    description:
      "County fairs, agricultural fairs, and community fairs featuring livestock, produce, and family entertainment across New England.",
  },
  festivals: {
    label: "Festivals",
    category: "Festival",
    description:
      "Music festivals, food festivals, harvest celebrations, and cultural festivals happening across Maine, Vermont, New Hampshire, and Massachusetts.",
  },
  "craft-shows": {
    label: "Craft Shows",
    category: "Craft Show",
    description:
      "Juried craft shows and artisan exhibitions showcasing handmade goods, pottery, jewelry, and fine art across New England.",
  },
  "craft-fairs": {
    label: "Craft Fairs",
    category: "Craft Fair",
    description:
      "Community craft fairs with local artisans, handmade crafts, and unique gifts throughout New England.",
  },
  markets: {
    label: "Markets",
    category: "Market",
    description:
      "Open-air markets, flea markets, and specialty markets featuring unique goods and local products in New England.",
  },
  "farmers-markets": {
    label: "Farmers Markets",
    category: "Farmers Market",
    description:
      "Fresh produce, local meats, baked goods, and artisan foods at farmers markets across Maine, Vermont, New Hampshire, and Massachusetts.",
  },
};

/**
 * OPE-1668 — upcoming renders are a slice of ONE cached set per category
 * (src/lib/events/listing-family-cache.ts), so `?page=` costs no D1.
 * `includePast=true` (the category's whole history) stays a live paged read.
 */
async function getCategoryEvents(
  category: string,
  page: number,
  limit: number,
  includePast: boolean = false
) {
  const db = getCloudflareDb();
  if (!includePast) {
    const set = await getCachedCategoryUpcomingSet(db, getCloudflareRateLimitKv(), category);
    return { events: pageSlice(set, page, limit), total: set.length, page, limit };
  }
  const offset = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    loadCategoryEventCards(db, category, { includePast: true, limit, offset }),
    countCategoryEvents(db, category, true),
  ]);
  return { events: rows, total, page, limit };
}

interface CategoryEventsPageProps {
  categorySlug: string;
  searchParams: { page?: string; includePast?: string };
}

export async function CategoryEventsPage({ categorySlug, searchParams }: CategoryEventsPageProps) {
  const cat = CATEGORY_MAP[categorySlug];
  if (!cat) return null;

  const page = parseInt(searchParams.page || "1");
  const limit = 30;
  const includePast = searchParams.includePast === "true";
  const { events: eventsList, total } = await getCategoryEvents(
    cat.category,
    page,
    limit,
    includePast
  );
  const totalPages = Math.ceil(total / limit);

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <ItemListSchema
        name={`${cat.label} in New England`}
        description={cat.description}
        items={eventsList.map((e) => ({
          name: e.name,
          url: `https://meetmeatthefair.com/events/${e.slug}`,
          image: e.imageUrl,
        }))}
        totalCount={total}
        positionStart={(page - 1) * limit + 1}
        asCollectionPage
        pageUrl={`https://meetmeatthefair.com/events/${categorySlug}`}
      />
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Events", url: "https://meetmeatthefair.com/events" },
          { name: cat.label, url: `https://meetmeatthefair.com/events/${categorySlug}` },
        ]}
      />

      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-amber-light">
            <Tag className="w-5 h-5 text-amber-fg" />
          </div>
          <h1 className="text-3xl font-bold text-foreground">{cat.label} in New England</h1>
        </div>
        <p className="mt-2 text-muted-foreground">
          Browse {total} {includePast ? "" : "upcoming "}
          {cat.label.toLowerCase()} across New England.
        </p>
        <nav className="mt-4 text-sm text-muted-foreground" aria-label="Breadcrumb">
          <Link href="/" className="hover:text-navy">
            Home
          </Link>
          <span className="mx-2">/</span>
          <Link href="/events" className="hover:text-navy">
            Events
          </Link>
          <span className="mx-2">/</span>
          <span className="text-foreground">{cat.label}</span>
        </nav>
      </div>

      <form className="mb-6 flex items-center gap-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="includePast"
            value="true"
            defaultChecked={includePast}
            className="rounded border-border text-royal focus:ring-royal"
          />
          <span className="text-sm text-foreground">Include past events</span>
        </label>
        <button type="submit" className="text-sm text-royal hover:text-navy font-medium">
          Apply
        </button>
      </form>

      {eventsList.length > 0 ? (
        <EventsView
          events={eventsList}
          view="cards"
          emptyMessage={`No upcoming ${cat.label.toLowerCase()} found. Check back soon!`}
          currentPage={page}
          totalPages={totalPages}
          searchParams={{
            ...(searchParams.page ? { page: searchParams.page } : {}),
            ...(includePast ? { includePast: "true" } : {}),
          }}
          total={total}
          basePath={`/events/${categorySlug}`}
        />
      ) : (
        <div className="text-center py-12">
          <Tag className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground text-lg">
            No upcoming {cat.label.toLowerCase()} found.
          </p>
          <p className="text-muted-foreground mt-2">
            Check back soon or{" "}
            <Link href="/events" className="text-royal hover:text-navy font-medium">
              browse all events
            </Link>
            .
          </p>
        </div>
      )}

      {cat.description && (
        <div className="mt-12 prose prose-gray max-w-none">
          <h2>About {cat.label} in New England</h2>
          <p>
            {cat.description} Browse our listings to find events near you, check dates and venues,
            and connect with vendors.
          </p>
        </div>
      )}
    </div>
  );
}
