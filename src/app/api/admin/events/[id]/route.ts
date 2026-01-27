import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, promoters, eventVendors, vendors } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
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

    const event = {
      ...eventData.events,
      venue: eventData.venues,
      promoter: eventData.promoters,
      eventVendors: eventVendorResults.map((ev) => ({
        ...ev.event_vendors,
        vendor: ev.vendors,
      })),
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

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name) {
      updateData.name = data.name;
      updateData.slug = createSlug(data.name);
    }
    if (data.description !== undefined) updateData.description = data.description;
    if (data.venueId) updateData.venueId = data.venueId;
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

    const [updatedEvent] = await db
      .select()
      .from(events)
      .where(eq(events.id, id))
      .limit(1);

    return NextResponse.json(updatedEvent);
  } catch (error) {
    console.error("Failed to update event:", error);
    return NextResponse.json({ error: "Failed to update event" }, { status: 500 });
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
