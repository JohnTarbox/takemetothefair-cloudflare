import { MetadataRoute } from "next";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, promoters, blogPosts } from "@/lib/db/schema";
import { eq, and, gte, isNotNull, count, sql } from "drizzle-orm";
import { isPublicEventStatus } from "@/lib/event-status";
import {
  getVendorTier,
  getSitemapPriorityTier,
  isIndexableTier,
  sitemapChangeFreqFor,
  sitemapPriorityFor,
  type VendorTierFields,
} from "@/lib/vendor-tier";
import { SITEMAP_MIN_COMPLETENESS } from "@/lib/completeness";

export const runtime = "edge";

// SQLite is dynamically typed, so a non-numeric value (e.g. an ISO string
// written via raw SQL or a restore) lands in an `integer { mode: "timestamp" }`
// column unchanged. Drizzle then deserializes it as `new Date(NaN * 1000)` =
// Invalid Date, which is truthy but throws from `.toISOString()` during XML
// serialization (after this handler returns, so the try/catch below cannot
// catch it). Guard every row's lastmod through this helper.
function safeLastMod(value: Date | null | undefined): Date {
  if (value && !isNaN(value.getTime())) return value;
  return new Date();
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = "https://meetmeatthefair.com";

  // Static pages
  const staticPages: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1,
    },
    {
      url: `${baseUrl}/events`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: `${baseUrl}/events/past`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${baseUrl}/events/all`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/events/maine`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.85,
    },
    {
      url: `${baseUrl}/events/vermont`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.85,
    },
    {
      url: `${baseUrl}/events/new-hampshire`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.85,
    },
    {
      url: `${baseUrl}/events/massachusetts`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.85,
    },
    {
      url: `${baseUrl}/events/connecticut`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.85,
    },
    {
      url: `${baseUrl}/events/rhode-island`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.85,
    },
    {
      url: `${baseUrl}/events/fairs`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/events/festivals`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/events/craft-shows`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/events/craft-fairs`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/events/markets`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/events/farmers-markets`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/venues`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/vendors`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/promoters`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${baseUrl}/blog`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.7,
    },
    {
      url: `${baseUrl}/about`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${baseUrl}/contact`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${baseUrl}/faq`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${baseUrl}/search-visibility`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      url: `${baseUrl}/for-promoters`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${baseUrl}/for-vendors`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${baseUrl}/privacy`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${baseUrl}/terms`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.3,
    },
  ];

  try {
    const db = getCloudflareDb();

    // Get approved events. §10.2 quality gate: drop entries below
    // SITEMAP_MIN_COMPLETENESS so near-empty stubs don't dilute the sitemap.
    // Also exclude NULL-start TENTATIVE rows — no temporal content for crawlers,
    // and they're filtered out of every public listing page anyway.
    const eventResults = await db
      .select({ slug: events.slug, updatedAt: events.updatedAt, endDate: events.endDate })
      .from(events)
      .where(
        and(
          isPublicEventStatus(),
          isNotNull(events.startDate),
          gte(events.completenessScore, SITEMAP_MIN_COMPLETENESS)
        )
      );

    const now = new Date();
    const eventPages: MetadataRoute.Sitemap = eventResults.map((event) => {
      const isPast = event.endDate && new Date(event.endDate) < now;
      return {
        url: `${baseUrl}/events/${event.slug}`,
        lastModified: safeLastMod(event.updatedAt),
        changeFrequency: isPast ? ("monthly" as const) : ("weekly" as const),
        priority: isPast ? 0.5 : 0.7,
      };
    });

    // Get active venues
    const venueResults = await db
      .select({ slug: venues.slug, updatedAt: venues.updatedAt })
      .from(venues)
      .where(eq(venues.status, "ACTIVE"));

    const venuePages: MetadataRoute.Sitemap = venueResults.map((venue) => ({
      url: `${baseUrl}/venues/${venue.slug}`,
      lastModified: safeLastMod(venue.updatedAt),
      changeFrequency: "monthly" as const,
      priority: 0.6,
    }));

    // Get vendors. The SEO gate is applied as raw SQL so we can reference
    // event_vendors → events → venues for the geographic-anchor fallback,
    // which Drizzle's query builder can't express cleanly. Within the
    // indexable set, getSitemapPriorityTier() classifies HIGH/MEDIUM/LOW
    // for <priority> and <changefreq>. Google largely ignores those signals;
    // Bing still uses them and currently delivers >4× MMATF's organic
    // traffic of Google, so the gradient is meaningful.
    //
    // The EXISTS subquery in the WHERE and the correlated COUNT in the
    // SELECT both walk event_vendors → events → venues; SQLite plans these
    // independently, so they can't share work. At ~1.3K vendors this is
    // fine; if it gets expensive, cache an `eventVenueGeoCount` column.
    const vendorRows = await db.all<{
      slug: string;
      updatedAt: number | null;
      description: string | null;
      website: string | null;
      socialLinks: string | null;
      city: string | null;
      state: string | null;
      address: string | null;
      enhancedProfile: number;
      domainHijacked: number;
      eventAssociationCount: number;
      eventVenueGeoCount: number;
    }>(sql`
      SELECT
        v.slug AS slug,
        v.updated_at AS updatedAt,
        v.description AS description,
        v.website AS website,
        v.social_links AS socialLinks,
        v.city AS city,
        v.state AS state,
        v.address AS address,
        v.enhanced_profile AS enhancedProfile,
        v.domain_hijacked AS domainHijacked,
        (SELECT COUNT(*) FROM event_vendors ev WHERE ev.vendor_id = v.id) AS eventAssociationCount,
        (
          SELECT COUNT(*) FROM event_vendors ev
          JOIN events e ON ev.event_id = e.id
          JOIN venues vn ON e.venue_id = vn.id
          WHERE ev.vendor_id = v.id
            AND vn.city IS NOT NULL AND vn.city != ''
            AND vn.state IS NOT NULL AND vn.state != ''
        ) AS eventVenueGeoCount
      FROM vendors v
      WHERE v.deleted_at IS NULL
        AND v.domain_hijacked = 0
        AND (
          v.enhanced_profile = 1
          OR (
            v.description IS NOT NULL AND length(trim(v.description)) >= 30
            AND (
              (v.city IS NOT NULL AND v.city != '' AND v.state IS NOT NULL AND v.state != '')
              OR (v.address IS NOT NULL AND v.address != '')
              OR EXISTS (
                SELECT 1 FROM event_vendors ev2
                JOIN events e2 ON ev2.event_id = e2.id
                JOIN venues vn2 ON e2.venue_id = vn2.id
                WHERE ev2.vendor_id = v.id
                  AND vn2.city IS NOT NULL AND vn2.city != ''
                  AND vn2.state IS NOT NULL AND vn2.state != ''
              )
            )
          )
        )
        AND v.completeness_score >= ${SITEMAP_MIN_COMPLETENESS}
    `);

    const vendorPages: MetadataRoute.Sitemap = vendorRows
      .map((row) => {
        const fields: VendorTierFields = {
          description: row.description,
          website: row.website,
          socialLinks: row.socialLinks,
          city: row.city,
          state: row.state,
          address: row.address,
          enhancedProfile: row.enhancedProfile === 1,
          domainHijacked: row.domainHijacked === 1,
          eventAssociationCount: row.eventAssociationCount,
          eventVenueGeoCount: row.eventVenueGeoCount,
        };
        return { row, fields, tier: getVendorTier(fields) };
      })
      // Defense-in-depth: the SQL gate already excludes non-indexable
      // vendors, but if criteria drift between SQL and TS, the TS check
      // wins so we never emit a row inconsistent with the noindex meta.
      .filter(({ tier }) => isIndexableTier(tier))
      .map(({ row, fields, tier }) => {
        const priorityTier = getSitemapPriorityTier(fields, tier);
        return {
          url: `${baseUrl}/vendors/${row.slug}`,
          lastModified: safeLastMod(row.updatedAt ? new Date(row.updatedAt * 1000) : null),
          changeFrequency: sitemapChangeFreqFor(priorityTier),
          priority: sitemapPriorityFor(priorityTier),
        };
      });

    // Get promoters (no public/private gate — promoters table has no status
    // column; verified is just a trust badge, not a visibility filter).
    const promoterResults = await db
      .select({ slug: promoters.slug, updatedAt: promoters.updatedAt })
      .from(promoters);

    const promoterPages: MetadataRoute.Sitemap = promoterResults.map((p) => ({
      url: `${baseUrl}/promoters/${p.slug}`,
      lastModified: safeLastMod(p.updatedAt),
      changeFrequency: "monthly" as const,
      priority: 0.5,
    }));

    // Get published blog posts (need `tags` for the tag-landing-page entries below)
    const blogResults = await db
      .select({
        slug: blogPosts.slug,
        updatedAt: blogPosts.updatedAt,
        tags: blogPosts.tags,
      })
      .from(blogPosts)
      .where(eq(blogPosts.status, "PUBLISHED"));

    const blogPages: MetadataRoute.Sitemap = blogResults.map((post) => ({
      url: `${baseUrl}/blog/${post.slug}`,
      lastModified: safeLastMod(post.updatedAt),
      changeFrequency: "weekly" as const,
      priority: 0.6,
    }));

    // Collect every tag referenced by any published post and emit one URL per
    // unique tag-slug. Slugging logic must mirror /blog/tag/[tag]/page.tsx.
    const tagSlugToLastMod = new Map<string, Date>();
    for (const post of blogResults) {
      let tagsArr: string[] = [];
      try {
        tagsArr = JSON.parse(post.tags || "[]") as string[];
      } catch {
        tagsArr = [];
      }
      const postMod = safeLastMod(post.updatedAt);
      for (const raw of tagsArr) {
        const slug = raw
          .toLowerCase()
          .replace(/[^\w\s-]/g, "")
          .replace(/\s+/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "");
        if (!slug) continue;
        const existing = tagSlugToLastMod.get(slug);
        if (!existing || postMod > existing) tagSlugToLastMod.set(slug, postMod);
      }
    }

    const tagPages: MetadataRoute.Sitemap = Array.from(tagSlugToLastMod.entries()).map(
      ([slug, lastMod]) => ({
        url: `${baseUrl}/blog/tag/${slug}`,
        lastModified: lastMod,
        changeFrequency: "weekly" as const,
        priority: 0.4,
      })
    );

    // Generate pagination URLs for listing pages to reduce orphan rate
    const EVENTS_PER_PAGE = 30;
    const paginationPages: MetadataRoute.Sitemap = [];

    // Count future public events for /events pagination. Mirror the page
    // query's filter exactly so total page count matches the result set.
    const futureCountResult = await db
      .select({ count: count() })
      .from(events)
      .where(and(isPublicEventStatus(), isNotNull(events.startDate), gte(events.endDate, now)));
    const futureTotal = futureCountResult[0]?.count || 0;
    const futureTotalPages = Math.ceil(futureTotal / EVENTS_PER_PAGE);

    for (let page = 2; page <= futureTotalPages; page++) {
      paginationPages.push({
        url: `${baseUrl}/events?page=${page}`,
        lastModified: new Date(),
        changeFrequency: "daily" as const,
        priority: 0.6,
      });
    }

    // Count all public events for /events/all pagination
    const allCountResult = await db
      .select({ count: count() })
      .from(events)
      .where(isPublicEventStatus());
    const allTotal = allCountResult[0]?.count || 0;
    const allTotalPages = Math.ceil(allTotal / EVENTS_PER_PAGE);

    for (let page = 2; page <= allTotalPages; page++) {
      paginationPages.push({
        url: `${baseUrl}/events/all?page=${page}`,
        lastModified: new Date(),
        changeFrequency: "weekly" as const,
        priority: 0.5,
      });
    }

    return [
      ...staticPages,
      ...paginationPages,
      ...eventPages,
      ...venuePages,
      ...vendorPages,
      ...promoterPages,
      ...blogPages,
      ...tagPages,
    ];
  } catch (error) {
    console.error("Error generating sitemap:", error);
    return staticPages;
  }
}
