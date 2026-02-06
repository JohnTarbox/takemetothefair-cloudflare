import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, promoters, eventSchemaOrg } from "@/lib/db/schema";
import { parseJsonLd } from "@/lib/schema-org";
import { eq } from "drizzle-orm";
import { createSlug } from "@/lib/utils";
import { logError } from "@/lib/logger";

export const runtime = "edge";

// The stable ID for the Community Suggestions promoter
const COMMUNITY_PROMOTER_ID = "system-community-suggestions";

const submitEventSchema = z.object({
  name: z.string().min(1, "Event name is required"),
  description: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  venueName: z.string().nullable().optional(),
  venueAddress: z.string().nullable().optional(),
  venueCity: z.string().nullable().optional(),
  venueState: z.string().nullable().optional(),
  ticketUrl: z.string().nullable().optional(),
  ticketPriceMin: z.number().nullable().optional(),
  ticketPriceMax: z.number().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  sourceUrl: z.string().url().optional(),
  suggesterEmail: z.string().email().optional().or(z.literal("")),
  jsonLd: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: NextRequest) {
  const db = getCloudflareDb();

  try {
    const body = await request.json();
    const validation = submitEventSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: validation.error.issues[0]?.message || "Validation failed" },
        { status: 400 }
      );
    }

    const data = validation.data;

    // Verify the community promoter exists
    const promoter = await db
      .select()
      .from(promoters)
      .where(eq(promoters.id, COMMUNITY_PROMOTER_ID))
      .limit(1);

    if (promoter.length === 0) {
      // Create it if it doesn't exist (for non-seeded databases)
      await db.insert(promoters).values({
        id: COMMUNITY_PROMOTER_ID,
        userId: null,
        companyName: "Community Suggestions",
        slug: "community-suggestions",
        description: "Events suggested by the community. These events are pending admin review.",
        verified: false,
      });
    }

    // Generate event slug
    const eventSlug = createSlug(data.name);
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

    if (data.startDate) {
      startDate = new Date(data.startDate);
      if (isNaN(startDate.getTime())) startDate = null;
    }

    if (data.endDate) {
      endDate = new Date(data.endDate);
      if (isNaN(endDate.getTime())) endDate = null;
    }

    // Build description with location info if provided
    let description = data.description || `${data.name} - suggested by the community`;
    if (data.venueName || data.venueCity) {
      const locationParts: string[] = [];
      if (data.venueName) locationParts.push(data.venueName);
      if (data.venueAddress) locationParts.push(data.venueAddress);
      if (data.venueCity) locationParts.push(data.venueCity);
      if (data.venueState) locationParts.push(data.venueState);
      if (locationParts.length > 0 && !description.includes(locationParts[0])) {
        description += `\n\nLocation: ${locationParts.join(", ")}`;
      }
    }

    // Create the event with PENDING status
    const newEventId = crypto.randomUUID();
    await db.insert(events).values({
      id: newEventId,
      name: data.name,
      slug: finalEventSlug,
      description,
      promoterId: COMMUNITY_PROMOTER_ID,
      venueId: null, // Community suggestions don't auto-create venues
      startDate,
      endDate,
      datesConfirmed: startDate !== null,
      categories: JSON.stringify(["Event"]),
      tags: JSON.stringify(["community-suggestion"]),
      ticketUrl: data.ticketUrl || data.sourceUrl || null,
      ticketPriceMin: data.ticketPriceMin ?? null,
      ticketPriceMax: data.ticketPriceMax ?? null,
      imageUrl: data.imageUrl || null,
      status: "PENDING",
      sourceName: "community-suggestion",
      sourceUrl: data.sourceUrl || null,
      sourceId: data.sourceUrl ? createSlug(data.sourceUrl) : newEventId,
      syncEnabled: false,
      lastSyncedAt: new Date(),
      suggesterEmail: data.suggesterEmail || null,
    });

    // Store schema.org data if JSON-LD was provided
    if (data.jsonLd) {
      try {
        const parseResult = parseJsonLd(data.jsonLd);
        const now = new Date();
        const ticketUrl = data.ticketUrl || data.sourceUrl || null;

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
        name: data.name,
      },
    });
  } catch (error) {
    await logError(db, { message: "Error submitting event suggestion", error, source: "api/suggest-event/submit", request });
    return NextResponse.json(
      { success: false, error: "Failed to submit event suggestion. Please try again." },
      { status: 500 }
    );
  }
}
