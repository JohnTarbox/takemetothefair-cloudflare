import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, vendors, blogPosts } from "@/lib/db/schema";
import { and, gte, eq, sql, desc } from "drizzle-orm";
import { isPublicEventStatus } from "@/lib/event-status";
import { withErrorHandler } from "@/lib/api-handler";

export const runtime = "edge";

export const GET = withErrorHandler(async (request: Request) => {
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim();

  if (!q || q.length < 2) {
    return NextResponse.json({ events: [], venues: [], vendors: [] });
  }

  const db = getCloudflareDb();
  const searchTerm = `%${q}%`;

  const [eventResults, venueResults, vendorResults, blogResults] = await Promise.all([
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
      .where(
        and(
          isPublicEventStatus(),
          gte(events.endDate, new Date()),
          sql`LOWER(${events.name}) LIKE LOWER(${searchTerm})`
        )
      )
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
        businessName: vendors.businessName,
        slug: vendors.slug,
        vendorType: vendors.vendorType,
      })
      .from(vendors)
      .where(sql`LOWER(${vendors.businessName}) LIKE LOWER(${searchTerm})`)
      .orderBy(vendors.businessName)
      .limit(5),

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
          sql`(LOWER(${blogPosts.title}) LIKE LOWER(${searchTerm}) OR LOWER(${blogPosts.body}) LIKE LOWER(${searchTerm}))`
        )
      )
      .orderBy(desc(blogPosts.publishDate))
      .limit(5),
  ]);

  return NextResponse.json({
    events: eventResults.map((e) => ({
      name: e.name,
      slug: e.slug,
      startDate: e.startDate,
      endDate: e.endDate,
      venue: e.venueName ? { name: e.venueName, city: e.venueCity, state: e.venueState } : null,
    })),
    venues: venueResults,
    vendors: vendorResults,
    blogPosts: blogResults,
  });
}, "api/search");
