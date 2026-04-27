import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, promoters, eventVendors, eventDays } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { isPublicEventStatus } from "@/lib/event-status";
import { isPublicVendorStatus } from "@/lib/vendor-status";
import { parseJsonArray } from "@/types";
import { logError } from "@/lib/logger";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const db = getCloudflareDb();
  try {
    const { slug } = await params;

    // Get event with venue and promoter
    const results = await db
      .select({
        id: events.id,
        name: events.name,
        slug: events.slug,
        description: events.description,
        startDate: events.startDate,
        endDate: events.endDate,
        categories: events.categories,
        imageUrl: events.imageUrl,
        status: events.status,
        vendorFeeMin: events.vendorFeeMin,
        vendorFeeMax: events.vendorFeeMax,
        vendorFeeNotes: events.vendorFeeNotes,
        indoorOutdoor: events.indoorOutdoor,
        estimatedAttendance: events.estimatedAttendance,
        eventScale: events.eventScale,
        walkInsAllowed: events.walkInsAllowed,
        datesConfirmed: events.datesConfirmed,
        applicationDeadline: events.applicationDeadline,
        applicationUrl: events.applicationUrl,
        applicationInstructions: events.applicationInstructions,
        // Venue
        venueName: venues.name,
        venueSlug: venues.slug,
        venueAddress: venues.address,
        venueCity: venues.city,
        venueState: venues.state,
        venueZip: venues.zip,
        venueContactEmail: venues.contactEmail,
        venueContactPhone: venues.contactPhone,
        // Promoter
        promoterName: promoters.companyName,
        promoterSlug: promoters.slug,
        promoterWebsite: promoters.website,
      })
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(and(eq(events.slug, slug), isPublicEventStatus()))
      .limit(1);

    if (results.length === 0) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const e = results[0];

    // Count public vendors and get event day schedule
    const [vendorCountResult, dayResults] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(eventVendors)
        .where(and(eq(eventVendors.eventId, e.id), isPublicVendorStatus())),
      db
        .select({
          date: eventDays.date,
          openTime: eventDays.openTime,
          closeTime: eventDays.closeTime,
          notes: eventDays.notes,
          closed: eventDays.closed,
        })
        .from(eventDays)
        .where(eq(eventDays.eventId, e.id))
        .orderBy(eventDays.date),
    ]);

    const vendorCount = vendorCountResult[0]?.count ?? 0;

    // Build booth fee object
    const boothFee =
      e.vendorFeeMin != null || e.vendorFeeMax != null
        ? {
            min: e.vendorFeeMin,
            max: e.vendorFeeMax,
            notes: e.vendorFeeNotes,
          }
        : null;

    return NextResponse.json({
      id: e.id,
      name: e.name,
      slug: e.slug,
      startDate: e.startDate,
      endDate: e.endDate,
      datesConfirmed: e.datesConfirmed,
      description: e.description,
      categories: parseJsonArray(e.categories),
      imageUrl: e.imageUrl,
      status: e.status,
      indoorOutdoor: e.indoorOutdoor,
      estimatedAttendance: e.estimatedAttendance,
      eventScale: e.eventScale,
      vendorFeeMin: e.vendorFeeMin,
      vendorFeeMax: e.vendorFeeMax,
      vendorFeeNotes: e.vendorFeeNotes,
      walkInsAllowed: e.walkInsAllowed,
      boothFee,
      applicationDeadline: e.applicationDeadline,
      applicationUrl: e.applicationUrl,
      applicationInstructions: e.applicationInstructions,
      venue: e.venueName
        ? {
            name: e.venueName,
            slug: e.venueSlug,
            address: e.venueAddress,
            city: e.venueCity,
            state: e.venueState,
            zip: e.venueZip,
            contactEmail: e.venueContactEmail,
            contactPhone: e.venueContactPhone,
          }
        : null,
      promoter: e.promoterName
        ? {
            name: e.promoterName,
            slug: e.promoterSlug,
            website: e.promoterWebsite,
          }
        : null,
      vendorCount,
      eventDays: dayResults.length > 0 ? dayResults : null,
    });
  } catch (error) {
    await logError(db, {
      message: "Error fetching event details",
      error,
      source: "api/events/[slug]",
      request,
    });
    return NextResponse.json({ error: "Failed to fetch event" }, { status: 500 });
  }
}
