import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, promoters, eventSchemaOrg } from "@/lib/db/schema";
import { parseJsonLd } from "@/lib/schema-org";
import { eq } from "drizzle-orm";
import { createSlug } from "@/lib/utils";
import type { VenueOption, ExtractedEventData } from "@/lib/url-import/types";
import { logError } from "@/lib/logger";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { geocodeAddress } from "@/lib/google-maps";

export const runtime = "edge";

interface ImportRequest {
  event: ExtractedEventData & {
    datesConfirmed?: boolean;
  };
  venueOption: VenueOption;
  promoterId: string;
  sourceUrl?: string;
  jsonLd?: Record<string, unknown>; // JSON-LD from the source page for schema.org storage
}

export async function POST(request: NextRequest) {
  const db = getCloudflareDb();
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as ImportRequest;
    const { event, venueOption, promoterId, sourceUrl, jsonLd } = body;

    // Validate required fields
    if (!event.name) {
      return NextResponse.json(
        { success: false, error: "Event name is required" },
        { status: 400 }
      );
    }

    if (!promoterId) {
      return NextResponse.json(
        { success: false, error: "Promoter is required" },
        { status: 400 }
      );
    }

    // Verify promoter exists
    const promoter = await db
      .select()
      .from(promoters)
      .where(eq(promoters.id, promoterId))
      .limit(1);

    if (promoter.length === 0) {
      return NextResponse.json(
        { success: false, error: "Promoter not found" },
        { status: 400 }
      );
    }

    // Handle venue
    let venueId: string | null = null;

    if (venueOption.type === "existing") {
      // Verify venue exists
      const existingVenue = await db
        .select()
        .from(venues)
        .where(eq(venues.id, venueOption.id))
        .limit(1);

      if (existingVenue.length === 0) {
        return NextResponse.json(
          { success: false, error: "Venue not found" },
          { status: 400 }
        );
      }
      venueId = venueOption.id;
    } else if (venueOption.type === "new") {
      // Create new venue
      const venueSlug = createSlug(venueOption.name);

      // Check if venue slug already exists
      let finalVenueSlug = venueSlug;
      let slugSuffix = 0;
      while (true) {
        const existingSlug = await db
          .select()
          .from(venues)
          .where(
            eq(venues.slug, slugSuffix > 0 ? `${venueSlug}-${slugSuffix}` : venueSlug)
          )
          .limit(1);
        if (existingSlug.length === 0) break;
        slugSuffix++;
      }
      if (slugSuffix > 0) {
        finalVenueSlug = `${venueSlug}-${slugSuffix}`;
      }

      const newVenueId = crypto.randomUUID();
      await db.insert(venues).values({
        id: newVenueId,
        name: venueOption.name,
        slug: finalVenueSlug,
        address: venueOption.address || "",
        city: venueOption.city || "",
        state: venueOption.state || "",
        zip: "",
        status: "ACTIVE",
      });
      venueId = newVenueId;

      // Auto-geocode the new venue
      try {
        const cfEnv = getCloudflareEnv();
        const geo = await geocodeAddress(
          venueOption.address || "",
          venueOption.city || "",
          venueOption.state || "",
          undefined,
          cfEnv.GOOGLE_MAPS_API_KEY
        );
        if (geo) {
          const geoUpdates: Record<string, unknown> = {
            latitude: geo.lat,
            longitude: geo.lng,
            updatedAt: new Date(),
          };
          if (geo.zip) geoUpdates.zip = geo.zip;
          await db.update(venues).set(geoUpdates).where(eq(venues.id, newVenueId));
        }
      } catch {
        // Non-blocking: venue still created without coordinates
      }
    }
    // For type === "none", venueId remains null

    // Generate event slug
    const eventSlug = createSlug(event.name);
    let finalEventSlug = eventSlug;
    let slugSuffix = 0;
    while (true) {
      const existingSlug = await db
        .select()
        .from(events)
        .where(
          eq(events.slug, slugSuffix > 0 ? `${eventSlug}-${slugSuffix}` : eventSlug)
        )
        .limit(1);
      if (existingSlug.length === 0) break;
      slugSuffix++;
    }
    if (slugSuffix > 0) {
      finalEventSlug = `${eventSlug}-${slugSuffix}`;
    }

    // Parse dates
    let startDate: Date | null = null;
    let endDate: Date | null = null;

    if (event.startDate) {
      startDate = new Date(event.startDate);
      if (isNaN(startDate.getTime())) startDate = null;
    }

    if (event.endDate) {
      endDate = new Date(event.endDate);
      if (isNaN(endDate.getTime())) endDate = null;
    }

    // Create the event
    const newEventId = crypto.randomUUID();
    await db.insert(events).values({
      id: newEventId,
      name: event.name,
      slug: finalEventSlug,
      description: event.description || `${event.name} - imported from URL`,
      promoterId,
      venueId,
      startDate,
      endDate,
      datesConfirmed: event.datesConfirmed ?? (startDate !== null),
      categories: JSON.stringify(["Event"]),
      tags: JSON.stringify(["imported", "url-import"]),
      ticketUrl: event.ticketUrl || sourceUrl || null,
      ticketPriceMin: event.ticketPriceMin,
      ticketPriceMax: event.ticketPriceMax,
      imageUrl: event.imageUrl,
      status: "APPROVED",
      sourceName: "url-import",
      sourceUrl: sourceUrl || null,
      sourceId: sourceUrl ? createSlug(sourceUrl) : newEventId,
      syncEnabled: false,
      lastSyncedAt: new Date(),
    });

    // Store schema.org data if JSON-LD was provided
    if (jsonLd) {
      try {
        const parseResult = parseJsonLd(jsonLd);
        const now = new Date();
        const ticketUrl = event.ticketUrl || sourceUrl || null;

        await db.insert(eventSchemaOrg).values({
          id: crypto.randomUUID(),
          eventId: newEventId,
          ticketUrl,
          rawJsonLd: parseResult.rawJsonLd,
          schemaName: parseResult.data?.name || null,
          schemaDescription: parseResult.data?.description || null,
          schemaStartDate: parseResult.data?.startDate || null,
          schemaEndDate: parseResult.data?.endDate || null,
          schemaVenueName: parseResult.data?.venueName || null,
          schemaVenueAddress: parseResult.data?.venueAddress || null,
          schemaVenueCity: parseResult.data?.venueCity || null,
          schemaVenueState: parseResult.data?.venueState || null,
          schemaVenueLat: parseResult.data?.venueLat || null,
          schemaVenueLng: parseResult.data?.venueLng || null,
          schemaImageUrl: parseResult.data?.imageUrl || null,
          schemaTicketUrl: parseResult.data?.ticketUrl || null,
          schemaPriceMin: parseResult.data?.priceMin || null,
          schemaPriceMax: parseResult.data?.priceMax || null,
          schemaEventStatus: parseResult.data?.eventStatus || null,
          schemaOrganizerName: parseResult.data?.organizerName || null,
          schemaOrganizerUrl: parseResult.data?.organizerUrl || null,
          status: parseResult.status,
          lastFetchedAt: now,
          lastError: parseResult.error || null,
          fetchCount: 1,
          createdAt: now,
          updatedAt: now,
        });
      } catch (schemaError) {
        // Non-blocking: event still created without schema.org data
        console.error("Failed to store schema.org data:", schemaError);
      }
    }

    return NextResponse.json({
      success: true,
      event: {
        id: newEventId,
        slug: finalEventSlug,
      },
      venueId, // Return venueId for reuse in batch imports
    });
  } catch (error) {
    await logError(db, { message: "Error saving event", error, source: "api/admin/import-url", request });
    return NextResponse.json(
      { success: false, error: "Failed to save event. Please try again." },
      { status: 500 }
    );
  }
}
