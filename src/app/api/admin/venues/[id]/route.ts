import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { venues, events } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { createSlug } from "@/lib/utils";

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

    const venueResults = await db
      .select()
      .from(venues)
      .where(eq(venues.id, id))
      .limit(1);

    if (venueResults.length === 0) {
      return NextResponse.json({ error: "Venue not found" }, { status: 404 });
    }

    const venue = venueResults[0];

    // Get recent events for this venue
    const venueEvents = await db
      .select()
      .from(events)
      .where(eq(events.venueId, id))
      .orderBy(desc(events.startDate))
      .limit(10);

    return NextResponse.json({
      ...venue,
      events: venueEvents,
    });
  } catch (error) {
    console.error("Failed to fetch venue:", error);
    return NextResponse.json({ error: "Failed to fetch venue" }, { status: 500 });
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
      address,
      city,
      state,
      zip,
      latitude,
      longitude,
      capacity,
      amenities,
      contactEmail,
      contactPhone,
      website,
      description,
      imageUrl,
      status,
    } = body;

    const db = getCloudflareDb();

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (name) {
      updateData.name = name;
      updateData.slug = createSlug(name);
    }
    if (address) updateData.address = address;
    if (city) updateData.city = city;
    if (state) updateData.state = state;
    if (zip) updateData.zip = zip;
    if (latitude !== undefined) updateData.latitude = latitude;
    if (longitude !== undefined) updateData.longitude = longitude;
    if (capacity !== undefined) updateData.capacity = capacity;
    if (amenities) updateData.amenities = JSON.stringify(amenities);
    if (contactEmail !== undefined) updateData.contactEmail = contactEmail;
    if (contactPhone !== undefined) updateData.contactPhone = contactPhone;
    if (website !== undefined) updateData.website = website;
    if (description !== undefined) updateData.description = description;
    if (imageUrl !== undefined) updateData.imageUrl = imageUrl;
    if (status) updateData.status = status;

    await db.update(venues).set(updateData).where(eq(venues.id, id));

    const updatedVenue = await db
      .select()
      .from(venues)
      .where(eq(venues.id, id))
      .limit(1);

    return NextResponse.json(updatedVenue[0]);
  } catch (error) {
    console.error("Failed to update venue:", error);
    return NextResponse.json({ error: "Failed to update venue" }, { status: 500 });
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
    await db.delete(venues).where(eq(venues.id, id));
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete venue:", error);
    return NextResponse.json({ error: "Failed to delete venue" }, { status: 500 });
  }
}
