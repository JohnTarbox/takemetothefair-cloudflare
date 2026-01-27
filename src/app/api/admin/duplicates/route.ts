import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { venues, events, vendors, promoters } from "@/lib/db/schema";
import { sql, eq } from "drizzle-orm";
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

    switch (type) {
      case "venues": {
        const venueList = await db.select().from(venues).orderBy(venues.name);
        totalEntities = venueList.length;

        // Get event counts for each venue
        const venuesWithCounts = await Promise.all(
          venueList.map(async (venue) => {
            const [eventCount] = await db
              .select({ count: sql<number>`count(*)` })
              .from(events)
              .where(eq(events.venueId, venue.id));
            return {
              ...venue,
              _count: { events: eventCount?.count || 0 },
            };
          })
        );

        duplicates = findDuplicatePairs(
          venuesWithCounts,
          getVenueComparisonString,
          threshold
        );
        break;
      }

      case "events": {
        const eventList = await db.select().from(events).orderBy(events.name);
        totalEntities = eventList.length;

        // Get venue and promoter info for each event
        const eventsWithDetails = await Promise.all(
          eventList.map(async (event) => {
            const [venue] = await db
              .select({ name: venues.name })
              .from(venues)
              .where(eq(venues.id, event.venueId));
            const [promoter] = await db
              .select({ companyName: promoters.companyName })
              .from(promoters)
              .where(eq(promoters.id, event.promoterId));
            const [eventVendorCount] = await db
              .select({ count: sql<number>`count(*)` })
              .from(events)
              .where(eq(events.id, event.id));
            return {
              ...event,
              venue,
              promoter,
              _count: { eventVendors: eventVendorCount?.count || 0 },
            };
          })
        );

        duplicates = findDuplicatePairs(
          eventsWithDetails,
          getEventComparisonString,
          threshold
        );
        break;
      }

      case "vendors": {
        const vendorList = await db.select().from(vendors).orderBy(vendors.businessName);
        totalEntities = vendorList.length;

        // Get event vendor counts
        const vendorsWithCounts = await Promise.all(
          vendorList.map(async (vendor) => {
            const [eventVendorCount] = await db
              .select({ count: sql<number>`count(*)` })
              .from(events)
              .where(eq(events.id, vendor.id));
            return {
              ...vendor,
              _count: { eventVendors: eventVendorCount?.count || 0 },
            };
          })
        );

        duplicates = findDuplicatePairs(
          vendorsWithCounts,
          getVendorComparisonString,
          threshold
        );
        break;
      }

      case "promoters": {
        const promoterList = await db.select().from(promoters).orderBy(promoters.companyName);
        totalEntities = promoterList.length;

        // Get event counts
        const promotersWithCounts = await Promise.all(
          promoterList.map(async (promoter) => {
            const [eventCount] = await db
              .select({ count: sql<number>`count(*)` })
              .from(events)
              .where(eq(events.promoterId, promoter.id));
            return {
              ...promoter,
              _count: { events: eventCount?.count || 0 },
            };
          })
        );

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
    return NextResponse.json(
      { error: "Failed to find duplicates" },
      { status: 500 }
    );
  }
}
