import { MetadataRoute } from "next";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, vendors } from "@/lib/db/schema";
import { eq, gte } from "drizzle-orm";

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
      .select({ slug: events.slug, updatedAt: events.updatedAt })
      .from(events)
      .where(eq(events.status, "APPROVED"));

    const eventPages: MetadataRoute.Sitemap = eventResults.map((event) => ({
      url: `${baseUrl}/events/${event.slug}`,
      lastModified: event.updatedAt || new Date(),
      changeFrequency: "weekly" as const,
      priority: 0.7,
    }));

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

    return [...staticPages, ...eventPages, ...venuePages, ...vendorPages];
  } catch (error) {
    console.error("Error generating sitemap:", error);
    return staticPages;
  }
}
