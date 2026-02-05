import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, eventSchemaOrg } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { fetchSchemaOrg } from "@/lib/schema-org";
import { logError } from "@/lib/logger";

export const runtime = "edge";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/admin/events/[id]/schema-org
 * Returns stored schema.org data for an event
 */
export async function GET(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const db = getCloudflareDb();

  try {
    // Get the event and its schema.org data
    const [eventData] = await db
      .select({
        event: events,
        schemaOrg: eventSchemaOrg,
      })
      .from(events)
      .leftJoin(eventSchemaOrg, eq(events.id, eventSchemaOrg.eventId))
      .where(eq(events.id, id))
      .limit(1);

    if (!eventData) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return NextResponse.json({
      event: {
        id: eventData.event.id,
        name: eventData.event.name,
        description: eventData.event.description,
        ticketUrl: eventData.event.ticketUrl,
        startDate: eventData.event.startDate,
        endDate: eventData.event.endDate,
        ticketPriceMin: eventData.event.ticketPriceMin,
        ticketPriceMax: eventData.event.ticketPriceMax,
        imageUrl: eventData.event.imageUrl,
      },
      schemaOrg: eventData.schemaOrg,
    });
  } catch (error) {
    await logError(db, {
      message: "Failed to fetch schema.org data",
      error,
      source: "api/admin/events/[id]/schema-org",
      request,
    });
    return NextResponse.json({ error: "Failed to fetch schema.org data" }, { status: 500 });
  }
}

/**
 * POST /api/admin/events/[id]/schema-org
 * Fetches/refreshes schema.org data from the event's ticketUrl
 */
export async function POST(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const db = getCloudflareDb();

  try {
    // Get the event
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, id))
      .limit(1);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Check for body with custom URL (optional)
    let urlToFetch = event.ticketUrl;
    try {
      const body = await request.json() as { url?: string };
      if (body.url) {
        urlToFetch = body.url;
      }
    } catch {
      // No body or invalid JSON, use event's ticketUrl
    }

    if (!urlToFetch) {
      return NextResponse.json(
        { error: "No ticket URL configured for this event" },
        { status: 400 }
      );
    }

    // Fetch schema.org data from the URL
    const result = await fetchSchemaOrg(urlToFetch);

    // Get existing schema.org record if any
    const [existing] = await db
      .select()
      .from(eventSchemaOrg)
      .where(eq(eventSchemaOrg.eventId, id))
      .limit(1);

    const now = new Date();
    const schemaOrgData = {
      eventId: id,
      ticketUrl: urlToFetch,
      rawJsonLd: result.rawJsonLd,
      schemaName: result.data?.name || null,
      schemaDescription: result.data?.description || null,
      schemaStartDate: result.data?.startDate || null,
      schemaEndDate: result.data?.endDate || null,
      schemaVenueName: result.data?.venueName || null,
      schemaVenueAddress: result.data?.venueAddress || null,
      schemaVenueCity: result.data?.venueCity || null,
      schemaVenueState: result.data?.venueState || null,
      schemaVenueLat: result.data?.venueLat || null,
      schemaVenueLng: result.data?.venueLng || null,
      schemaImageUrl: result.data?.imageUrl || null,
      schemaTicketUrl: result.data?.ticketUrl || null,
      schemaPriceMin: result.data?.priceMin || null,
      schemaPriceMax: result.data?.priceMax || null,
      schemaEventStatus: result.data?.eventStatus || null,
      schemaOrganizerName: result.data?.organizerName || null,
      schemaOrganizerUrl: result.data?.organizerUrl || null,
      status: result.status,
      lastFetchedAt: now,
      lastError: result.error || null,
      fetchCount: (existing?.fetchCount || 0) + 1,
      updatedAt: now,
    };

    if (existing) {
      // Update existing record
      await db
        .update(eventSchemaOrg)
        .set(schemaOrgData)
        .where(eq(eventSchemaOrg.id, existing.id));
    } else {
      // Insert new record
      await db.insert(eventSchemaOrg).values({
        id: crypto.randomUUID(),
        ...schemaOrgData,
        createdAt: now,
      });
    }

    // Return the fetched data
    const [updatedSchemaOrg] = await db
      .select()
      .from(eventSchemaOrg)
      .where(eq(eventSchemaOrg.eventId, id))
      .limit(1);

    return NextResponse.json({
      success: result.success,
      schemaOrg: updatedSchemaOrg,
      error: result.error,
    });
  } catch (error) {
    await logError(db, {
      message: "Failed to fetch schema.org data",
      error,
      source: "api/admin/events/[id]/schema-org",
      request,
    });
    return NextResponse.json(
      { error: "Failed to fetch schema.org data" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/admin/events/[id]/schema-org
 * Apply selected schema.org fields to the event
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const db = getCloudflareDb();

  try {
    const body = await request.json() as { fields: string[] };
    const { fields } = body;

    if (!fields || !Array.isArray(fields) || fields.length === 0) {
      return NextResponse.json(
        { error: "No fields specified to apply" },
        { status: 400 }
      );
    }

    // Get the schema.org data
    const [schemaOrg] = await db
      .select()
      .from(eventSchemaOrg)
      .where(eq(eventSchemaOrg.eventId, id))
      .limit(1);

    if (!schemaOrg || schemaOrg.status !== "available") {
      return NextResponse.json(
        { error: "No schema.org data available for this event" },
        { status: 400 }
      );
    }

    // Map schema.org fields to event fields
    const fieldMapping: Record<string, { eventField: string; schemaValue: unknown }> = {
      name: { eventField: "name", schemaValue: schemaOrg.schemaName },
      description: { eventField: "description", schemaValue: schemaOrg.schemaDescription },
      startDate: { eventField: "startDate", schemaValue: schemaOrg.schemaStartDate },
      endDate: { eventField: "endDate", schemaValue: schemaOrg.schemaEndDate },
      ticketPriceMin: { eventField: "ticketPriceMin", schemaValue: schemaOrg.schemaPriceMin },
      ticketPriceMax: { eventField: "ticketPriceMax", schemaValue: schemaOrg.schemaPriceMax },
      imageUrl: { eventField: "imageUrl", schemaValue: schemaOrg.schemaImageUrl },
      ticketUrl: { eventField: "ticketUrl", schemaValue: schemaOrg.schemaTicketUrl },
    };

    // Build update object with only the specified fields
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    const appliedFields: string[] = [];

    for (const field of fields) {
      const mapping = fieldMapping[field];
      if (mapping && mapping.schemaValue !== null && mapping.schemaValue !== undefined) {
        updateData[mapping.eventField] = mapping.schemaValue;
        appliedFields.push(field);
      }
    }

    if (appliedFields.length === 0) {
      return NextResponse.json(
        { error: "No valid fields to apply" },
        { status: 400 }
      );
    }

    // Update the event
    await db.update(events).set(updateData).where(eq(events.id, id));

    // Get updated event
    const [updatedEvent] = await db
      .select()
      .from(events)
      .where(eq(events.id, id))
      .limit(1);

    return NextResponse.json({
      success: true,
      appliedFields,
      event: updatedEvent,
    });
  } catch (error) {
    await logError(db, {
      message: "Failed to apply schema.org data",
      error,
      source: "api/admin/events/[id]/schema-org",
      request,
    });
    return NextResponse.json(
      { error: "Failed to apply schema.org data" },
      { status: 500 }
    );
  }
}
