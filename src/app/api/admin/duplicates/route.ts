import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { venues, events, vendors, promoters, eventVendors } from "@/lib/db/schema";
import { sql, eq, count, inArray } from "drizzle-orm";
import {
  findDuplicatePairs,
  getVenueComparisonString,
  getEventComparisonString,
  getVendorComparisonString,
  getPromoterComparisonString,
} from "@/lib/duplicates/similarity";
import type { DuplicateEntityType, FindDuplicatesResponse } from "@/lib/duplicates/types";

export const runtime = "edge";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const type = searchParams.get("type") as DuplicateEntityType | null;
  const threshold = parseFloat(searchParams.get("threshold") || "0.7");

  if (!type || !["venues", "events", "vendors", "promoters"].includes(type)) {
    return NextResponse.json(
      { error: "Invalid or missing type parameter" },
      { status: 400 }
    );
  }

  if (isNaN(threshold) || threshold < 0 || threshold > 1) {
    return NextResponse.json(
      { error: "Threshold must be between 0 and 1" },
      { status: 400 }
    );
  }

  try {
    const db = getCloudflareDb();
    let duplicates;
    let totalEntities = 0;

    // Limit entities to prevent timeout on Cloudflare Workers (30s CPU limit)
    // O(n²) comparisons with Levenshtein can be very slow
    const MAX_ENTITIES = 500;

    switch (type) {
      case "venues": {
        // Batch query: Get all venues (limited to prevent timeout)
        const venueList = await db.select().from(venues).orderBy(venues.name).limit(MAX_ENTITIES);
        totalEntities = venueList.length;

        // Batch query: Get event counts for ALL venues in one query
        const eventCounts = await db
          .select({
            venueId: events.venueId,
            count: count(),
          })
          .from(events)
          .groupBy(events.venueId);

        // Create lookup map
        const countMap = new Map(eventCounts.map((ec) => [ec.venueId, ec.count]));

        // Map in memory (no additional queries)
        const venuesWithCounts = venueList.map((venue) => ({
          ...venue,
          _count: { events: countMap.get(venue.id) || 0 },
        }));

        duplicates = findDuplicatePairs(
          venuesWithCounts,
          getVenueComparisonString,
          threshold
        );
        break;
      }

      case "events": {
        // Batch query: Get all events with venue and promoter JOINs (limited to prevent timeout)
        const eventResults = await db
          .select({
            event: events,
            venueName: venues.name,
            promoterName: promoters.companyName,
          })
          .from(events)
          .leftJoin(venues, eq(events.venueId, venues.id))
          .leftJoin(promoters, eq(events.promoterId, promoters.id))
          .orderBy(events.name)
          .limit(MAX_ENTITIES);

        totalEntities = eventResults.length;

        // Batch query: Get vendor counts for ALL events in one query
        const vendorCounts = await db
          .select({
            eventId: eventVendors.eventId,
            count: count(),
          })
          .from(eventVendors)
          .groupBy(eventVendors.eventId);

        // Create lookup map
        const vendorCountMap = new Map(vendorCounts.map((vc) => [vc.eventId, vc.count]));

        // Map in memory (no additional queries)
        const eventsWithDetails = eventResults.map((result) => ({
          ...result.event,
          venue: result.venueName ? { name: result.venueName } : null,
          promoter: result.promoterName ? { companyName: result.promoterName } : null,
          _count: { eventVendors: vendorCountMap.get(result.event.id) || 0 },
        }));

        duplicates = findDuplicatePairs(
          eventsWithDetails,
          getEventComparisonString,
          threshold
        );
        break;
      }

      case "vendors": {
        // Batch query: Get all vendors (limited to prevent timeout)
        const vendorList = await db.select().from(vendors).orderBy(vendors.businessName).limit(MAX_ENTITIES);
        totalEntities = vendorList.length;

        // Batch query: Get event vendor counts for ALL vendors in one query
        const vendorEventCounts = await db
          .select({
            vendorId: eventVendors.vendorId,
            count: count(),
          })
          .from(eventVendors)
          .groupBy(eventVendors.vendorId);

        // Create lookup map
        const countMap = new Map(vendorEventCounts.map((vc) => [vc.vendorId, vc.count]));

        // Map in memory (no additional queries)
        const vendorsWithCounts = vendorList.map((vendor) => ({
          ...vendor,
          _count: { eventVendors: countMap.get(vendor.id) || 0 },
        }));

        duplicates = findDuplicatePairs(
          vendorsWithCounts,
          getVendorComparisonString,
          threshold
        );
        break;
      }

      case "promoters": {
        // Batch query: Get all promoters (limited to prevent timeout)
        const promoterList = await db.select().from(promoters).orderBy(promoters.companyName).limit(MAX_ENTITIES);
        totalEntities = promoterList.length;

        // Batch query: Get event counts for ALL promoters in one query
        const eventCounts = await db
          .select({
            promoterId: events.promoterId,
            count: count(),
          })
          .from(events)
          .groupBy(events.promoterId);

        // Create lookup map
        const countMap = new Map(eventCounts.map((ec) => [ec.promoterId, ec.count]));

        // Map in memory (no additional queries)
        const promotersWithCounts = promoterList.map((promoter) => ({
          ...promoter,
          _count: { events: countMap.get(promoter.id) || 0 },
        }));

        duplicates = findDuplicatePairs(
          promotersWithCounts,
          getPromoterComparisonString,
          threshold
        );
        break;
      }
    }

    const response: FindDuplicatesResponse = {
      type,
      threshold,
      duplicates: duplicates.map((pair) => ({
        entity1: pair.entity1,
        entity2: pair.entity2,
        similarity: pair.similarity,
        matchedFields: ["name"],
      })),
      totalEntities,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Failed to find duplicates:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to find duplicates: ${message}` },
      { status: 500 }
    );
  }
}
