import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, promoters, eventVendors, vendors } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createSlug } from "@/lib/utils";


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

  try {
    const body = await request.json();
    const {
      name,
      description,
      venueId,
      startDate,
      endDate,
      categories,
      tags,
      ticketUrl,
      ticketPriceMin,
      ticketPriceMax,
      imageUrl,
      featured,
      status,
    } = body;

    const db = getCloudflareDb();

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (name) {
      updateData.name = name;
      updateData.slug = createSlug(name);
    }
    if (description !== undefined) updateData.description = description;
    if (venueId) updateData.venueId = venueId;
    if (startDate) updateData.startDate = new Date(startDate);
    if (endDate) updateData.endDate = new Date(endDate);
    if (categories) updateData.categories = JSON.stringify(categories);
    if (tags) updateData.tags = JSON.stringify(tags);
    if (ticketUrl !== undefined) updateData.ticketUrl = ticketUrl;
    if (ticketPriceMin !== undefined) updateData.ticketPriceMin = ticketPriceMin;
    if (ticketPriceMax !== undefined) updateData.ticketPriceMax = ticketPriceMax;
    if (imageUrl !== undefined) updateData.imageUrl = imageUrl;
    if (featured !== undefined) updateData.featured = featured;
    if (status) updateData.status = status;

    await db.update(events).set(updateData).where(eq(events.id, id));

    const updatedEvent = await db
      .select()
      .from(events)
      .where(eq(events.id, id))
      .limit(1);

    return NextResponse.json(updatedEvent[0]);
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
