import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { venues, events } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { createSlug } from "@/lib/utils";
import { venueUpdateSchema, validateRequestBody } from "@/lib/validations";

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

  // Validate request body
  const validation = await validateRequestBody(request, venueUpdateSchema);
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
    if (data.address) updateData.address = data.address;
    if (data.city) updateData.city = data.city;
    if (data.state) updateData.state = data.state;
    if (data.zip) updateData.zip = data.zip;
    if (data.latitude !== undefined) updateData.latitude = data.latitude;
    if (data.longitude !== undefined) updateData.longitude = data.longitude;
    if (data.capacity !== undefined) updateData.capacity = data.capacity;
    if (data.amenities) updateData.amenities = JSON.stringify(data.amenities);
    if (data.contactEmail !== undefined) updateData.contactEmail = data.contactEmail;
    if (data.contactPhone !== undefined) updateData.contactPhone = data.contactPhone;
    if (data.website !== undefined) updateData.website = data.website;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.imageUrl !== undefined) updateData.imageUrl = data.imageUrl;
    if (data.status) updateData.status = data.status;

    await db.update(venues).set(updateData).where(eq(venues.id, id));

    const [updatedVenue] = await db
      .select()
      .from(venues)
      .where(eq(venues.id, id))
      .limit(1);

    return NextResponse.json(updatedVenue);
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
