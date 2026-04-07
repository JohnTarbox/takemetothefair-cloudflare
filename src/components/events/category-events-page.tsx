import Link from "next/link";
import { Tag } from "lucide-react";
import { EventsView } from "@/components/events/events-view";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, promoters, eventVendors, vendors } from "@/lib/db/schema";
import { eq, and, gte, or, isNull, count, inArray, like } from "drizzle-orm";
import { isPublicVendorStatus } from "@/lib/vendor-status";
import { isPublicEventStatus } from "@/lib/event-status";
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

async function getCategoryEvents(
  category: string,
  page: number,
  limit: number,
  includePast: boolean = false
) {
  const db = getCloudflareDb();
  const offset = (page - 1) * limit;

  const conditions = [isPublicEventStatus(), like(events.categories, `%${category}%`)];
  if (!includePast) {
    conditions.push(or(gte(events.endDate, new Date()), isNull(events.endDate))!);
  }

  const results = await db
    .select()
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .leftJoin(promoters, eq(events.promoterId, promoters.id))
    .where(and(...conditions))
    .orderBy(events.startDate)
    .limit(limit)
    .offset(offset);

  const eventIds = results.map((r) => r.events.id);
  const allEventVendors: {
    eventId: string;
    vendorId: string;
    businessName: string;
    slug: string;
    logoUrl: string | null;
    vendorType: string | null;
  }[] = [];

  if (eventIds.length > 0) {
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

  const vendorsByEvent = new Map<string, typeof allEventVendors>();
  for (const ev of allEventVendors) {
    const existing = vendorsByEvent.get(ev.eventId) || [];
    existing.push(ev);
    vendorsByEvent.set(ev.eventId, existing);
  }

  const eventsWithVendors = results.map((r) => ({
    ...r.events,
    venue: r.venues,
    promoter: r.promoters,
    vendors: (vendorsByEvent.get(r.events.id) || []).map((ev) => ({
      id: ev.vendorId,
      businessName: ev.businessName,
      slug: ev.slug,
      logoUrl: ev.logoUrl,
      vendorType: ev.vendorType,
    })),
  }));

  const countResult = await db
    .select({ count: count() })
    .from(events)
    .where(and(...conditions));

  return {
    events: eventsWithVendors,
    total: countResult[0]?.count || 0,
    page,
    limit,
  };
}

interface CategoryEventsPageProps {
  categorySlug: string;
  searchParams: { page?: string; includePast?: string };
}

export async function CategoryEventsPage({ categorySlug, searchParams }: CategoryEventsPageProps) {
  const cat = CATEGORY_MAP[categorySlug];
  if (!cat) return null;

  const page = parseInt(searchParams.page || "1");
  const limit = 24;
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
            <Tag className="w-5 h-5 text-amber" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900">{cat.label} in New England</h1>
        </div>
        <p className="mt-2 text-gray-600">
          Browse {total} {includePast ? "" : "upcoming "}
          {cat.label.toLowerCase()} across New England.
        </p>
        <nav className="mt-4 text-sm text-gray-500" aria-label="Breadcrumb">
          <Link href="/" className="hover:text-royal">
            Home
          </Link>
          <span className="mx-2">/</span>
          <Link href="/events" className="hover:text-royal">
            Events
          </Link>
          <span className="mx-2">/</span>
          <span className="text-gray-900">{cat.label}</span>
        </nav>
      </div>

      <form className="mb-6 flex items-center gap-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="includePast"
            value="true"
            defaultChecked={includePast}
            className="rounded border-gray-300 text-royal focus:ring-royal"
          />
          <span className="text-sm text-gray-700">Include past events</span>
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
          <Tag className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-600 text-lg">No upcoming {cat.label.toLowerCase()} found.</p>
          <p className="text-gray-500 mt-2">
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
