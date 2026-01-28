import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, promoters, eventVendors, vendors, eventDays } from "@/lib/db/schema";
import { eq, and, ne } from "drizzle-orm";
import { createSlug } from "@/lib/utils";
import { eventUpdateSchema, validateRequestBody } from "@/lib/validations";

export const runtime = "edge";


interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const db = getCloudflareDb();

    const eventResults = await db
      .select()
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(eq(events.id, id))
      .limit(1);

    if (eventResults.length === 0) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const eventData = eventResults[0];

    // Get event vendors
    const eventVendorResults = await db
      .select()
      .from(eventVendors)
      .leftJoin(vendors, eq(eventVendors.vendorId, vendors.id))
      .where(eq(eventVendors.eventId, id));

    // Get event days
    const eventDayResults = await db
      .select()
      .from(eventDays)
      .where(eq(eventDays.eventId, id))
      .orderBy(eventDays.date);

    const event = {
      ...eventData.events,
      venue: eventData.venues,
      promoter: eventData.promoters,
      eventVendors: eventVendorResults.map((ev) => ({
        ...ev.event_vendors,
        vendor: ev.vendors,
      })),
      eventDays: eventDayResults,
    };

    return NextResponse.json(event);
  } catch (error) {
    console.error("Failed to fetch event:", error);
    return NextResponse.json({ error: "Failed to fetch event" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  // Validate request body
  const validation = await validateRequestBody(request, eventUpdateSchema);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const data = validation.data;

  try {
    const db = getCloudflareDb();

    // Get current event to check if slug needs updating
    const [currentEvent] = await db
      .select({ slug: events.slug })
      .from(events)
      .where(eq(events.id, id))
      .limit(1);

    if (!currentEvent) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name) {
      updateData.name = data.name;
      const newSlug = createSlug(data.name);

      // Only update slug if it would change
      if (newSlug !== currentEvent.slug) {
        // Check if new slug already exists for another event
        let slug = newSlug;
        let slugSuffix = 0;
        while (true) {
          const existingSlug = await db
            .select({ id: events.id })
            .from(events)
            .where(and(
              eq(events.slug, slugSuffix > 0 ? `${slug}-${slugSuffix}` : slug),
              ne(events.id, id)
            ))
            .limit(1);
          if (existingSlug.length === 0) break;
          slugSuffix++;
        }
        updateData.slug = slugSuffix > 0 ? `${slug}-${slugSuffix}` : slug;
      }
    }
    if (data.description !== undefined) updateData.description = data.description;
    if (data.venueId !== undefined) updateData.venueId = data.venueId || null;
    if (data.startDate !== undefined) {
      updateData.startDate = data.startDate ? new Date(data.startDate) : null;
    }
    if (data.endDate !== undefined) {
      updateData.endDate = data.endDate ? new Date(data.endDate) : null;
    }
    if (data.datesConfirmed !== undefined) updateData.datesConfirmed = data.datesConfirmed;
    if (data.categories) updateData.categories = JSON.stringify(data.categories);
    if (data.tags) updateData.tags = JSON.stringify(data.tags);
    if (data.ticketUrl !== undefined) updateData.ticketUrl = data.ticketUrl;
    if (data.ticketPriceMin !== undefined) updateData.ticketPriceMin = data.ticketPriceMin;
    if (data.ticketPriceMax !== undefined) updateData.ticketPriceMax = data.ticketPriceMax;
    if (data.imageUrl !== undefined) updateData.imageUrl = data.imageUrl;
    if (data.featured !== undefined) updateData.featured = data.featured;
    if (data.commercialVendorsAllowed !== undefined) updateData.commercialVendorsAllowed = data.commercialVendorsAllowed;
    if (data.status) updateData.status = data.status;

    await db.update(events).set(updateData).where(eq(events.id, id));

    // Handle eventDays update if provided
    if (data.eventDays !== undefined) {
      // Delete existing event days
      await db.delete(eventDays).where(eq(eventDays.eventId, id));

      // Insert new event days if any
      if (data.eventDays && data.eventDays.length > 0) {
        await db.insert(eventDays).values(
          data.eventDays.map((day) => ({
            id: crypto.randomUUID(),
            eventId: id,
            date: day.date,
            openTime: day.openTime,
            closeTime: day.closeTime,
            notes: day.notes || null,
            closed: day.closed || false,
          }))
        );
      }
    }

    const [updatedEvent] = await db
      .select()
      .from(events)
      .where(eq(events.id, id))
      .limit(1);

    return NextResponse.json(updatedEvent);
  } catch (error) {
    console.error("Failed to update event:", error);
    const message = error instanceof Error ? error.message : "Failed to update event";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const db = getCloudflareDb();
    await db.delete(events).where(eq(events.id, id));
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete event:", error);
    return NextResponse.json({ error: "Failed to delete event" }, { status: 500 });
  }
}
