import { MetadataRoute } from "next";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, vendors, blogPosts } from "@/lib/db/schema";
import { eq, and, or, gte, isNull, count } from "drizzle-orm";
import { isPublicEventStatus } from "@/lib/event-status";

export const runtime = "edge";

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

    // Get approved events
    const eventResults = await db
      .select({ slug: events.slug, updatedAt: events.updatedAt, endDate: events.endDate })
      .from(events)
      .where(isPublicEventStatus());

    const now = new Date();
    const eventPages: MetadataRoute.Sitemap = eventResults.map((event) => {
      const isPast = event.endDate && new Date(event.endDate) < now;
      return {
        url: `${baseUrl}/events/${event.slug}`,
        lastModified: event.updatedAt || new Date(),
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
      lastModified: venue.updatedAt || new Date(),
      changeFrequency: "monthly" as const,
      priority: 0.6,
    }));

    // Get vendors
    const vendorResults = await db
      .select({ slug: vendors.slug, updatedAt: vendors.updatedAt })
      .from(vendors);

    const vendorPages: MetadataRoute.Sitemap = vendorResults.map((vendor) => ({
      url: `${baseUrl}/vendors/${vendor.slug}`,
      lastModified: vendor.updatedAt || new Date(),
      changeFrequency: "monthly" as const,
      priority: 0.6,
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
      lastModified: post.updatedAt || new Date(),
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
      const postMod = post.updatedAt || new Date();
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

    // Count future public events for /events pagination
    const futureCountResult = await db
      .select({ count: count() })
      .from(events)
      .where(and(isPublicEventStatus(), or(gte(events.endDate, now), isNull(events.endDate))));
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
      ...blogPages,
      ...tagPages,
    ];
  } catch (error) {
    console.error("Error generating sitemap:", error);
    return staticPages;
  }
}
