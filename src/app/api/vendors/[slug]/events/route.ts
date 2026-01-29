import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, eventVendors, events, venues } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { logError } from "@/lib/logger";

export const runtime = "edge";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const db = getCloudflareDb();
  try {
    const { slug } = await params;

    // Get vendor by slug
    const vendorResults = await db
      .select({ id: vendors.id, businessName: vendors.businessName, slug: vendors.slug })
      .from(vendors)
      .where(eq(vendors.slug, slug))
      .limit(1);

    if (vendorResults.length === 0) {
      return NextResponse.json({ error: "Vendor not found" }, { status: 404 });
    }

    const vendor = vendorResults[0];

    // Get approved events for this vendor
    const eventResults = await db
      .select({
        id: events.id,
        name: events.name,
        slug: events.slug,
        description: events.description,
        startDate: events.startDate,
        endDate: events.endDate,
        imageUrl: events.imageUrl,
        categories: events.categories,
        venueName: venues.name,
        venueCity: venues.city,
        venueState: venues.state,
        venueAddress: venues.address,
        venueZip: venues.zip,
      })
      .from(eventVendors)
      .leftJoin(events, eq(eventVendors.eventId, events.id))
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(
        and(
          eq(eventVendors.vendorId, vendor.id),
          eq(eventVendors.status, "APPROVED"),
          eq(events.status, "APPROVED")
        )
      );

    // Format events with venue info
    const formattedEvents = eventResults
      .filter((e) => e.id !== null)
      .map((e) => ({
        id: e.id,
        name: e.name,
        slug: e.slug,
        description: e.description,
        startDate: e.startDate,
        endDate: e.endDate,
        imageUrl: e.imageUrl,
        categories: parseCategories(e.categories),
        venue: {
          name: e.venueName || "Unknown Venue",
          city: e.venueCity || "",
          state: e.venueState || "",
          address: e.venueAddress,
          zip: e.venueZip,
        },
      }));

    return NextResponse.json({
      vendor: {
        id: vendor.id,
        businessName: vendor.businessName,
        slug: vendor.slug,
      },
      events: formattedEvents,
    });
  } catch (error) {
    await logError(db, { message: "Error fetching vendor events", error, source: "api/vendors/[slug]/events", request });
    return NextResponse.json(
      { error: "Failed to fetch events" },
      { status: 500 }
    );
  }
}

function parseCategories(categories: unknown): string[] {
  if (!categories) return [];
  if (Array.isArray(categories)) return categories;
  if (typeof categories === "string") {
    try {
      const parsed = JSON.parse(categories);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}
