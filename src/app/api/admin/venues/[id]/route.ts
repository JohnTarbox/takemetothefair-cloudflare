import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { venues, events } from "@/lib/db/schema";
import { eq, desc, and, ne } from "drizzle-orm";
import { createSlug } from "@/lib/utils";
import { venueUpdateSchema, validateRequestBody } from "@/lib/validations";
import { logError } from "@/lib/logger";
import { findVenueByGooglePlaceId } from "@/lib/queries";

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

  const db = getCloudflareDb();
  try {
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
    await logError(db, { message: "Failed to fetch venue", error, source: "api/admin/venues/[id]", request });
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

  const db = getCloudflareDb();
  try {

    // Get current venue to check if slug needs updating
    const [currentVenue] = await db
      .select({ slug: venues.slug })
      .from(venues)
      .where(eq(venues.id, id))
      .limit(1);

    if (!currentVenue) {
      return NextResponse.json({ error: "Venue not found" }, { status: 404 });
    }

    // Check for duplicate Google Place ID (exclude current venue)
    if (data.googlePlaceId) {
      const existingVenue = await findVenueByGooglePlaceId(db, data.googlePlaceId, id);
      if (existingVenue) {
        return NextResponse.json(
          {
            error: `Another venue already uses this Google Place ID: "${existingVenue.name}" in ${existingVenue.city}, ${existingVenue.state}`,
            existingVenue: {
              id: existingVenue.id,
              name: existingVenue.name,
              city: existingVenue.city,
              state: existingVenue.state,
            },
          },
          { status: 409 }
        );
      }
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name) {
      updateData.name = data.name;
      const newSlug = createSlug(data.name);

      // Only update slug if it would change
      if (newSlug !== currentVenue.slug) {
        // Check if new slug already exists for another venue
        const slug = newSlug;
        let slugSuffix = 0;
        while (true) {
          const existingSlug = await db
            .select({ id: venues.id })
            .from(venues)
            .where(and(
              eq(venues.slug, slugSuffix > 0 ? `${slug}-${slugSuffix}` : slug),
              ne(venues.id, id)
            ))
            .limit(1);
          if (existingSlug.length === 0) break;
          slugSuffix++;
        }
        updateData.slug = slugSuffix > 0 ? `${slug}-${slugSuffix}` : slug;
      }
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
    if (data.googlePlaceId !== undefined) updateData.googlePlaceId = data.googlePlaceId;
    if (data.googleMapsUrl !== undefined) updateData.googleMapsUrl = data.googleMapsUrl;
    if (data.openingHours !== undefined) updateData.openingHours = data.openingHours;
    if (data.googleRating !== undefined) updateData.googleRating = data.googleRating;
    if (data.googleRatingCount !== undefined) updateData.googleRatingCount = data.googleRatingCount;
    if (data.googleTypes !== undefined) updateData.googleTypes = data.googleTypes;
    if (data.accessibility !== undefined) updateData.accessibility = data.accessibility;
    if (data.parking !== undefined) updateData.parking = data.parking;
    if (data.status) updateData.status = data.status;

    await db.update(venues).set(updateData).where(eq(venues.id, id));

    const [updatedVenue] = await db
      .select()
      .from(venues)
      .where(eq(venues.id, id))
      .limit(1);

    return NextResponse.json(updatedVenue);
  } catch (error) {
    await logError(db, { message: "Failed to update venue", error, source: "api/admin/venues/[id]", request });
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Handle unique constraint violations
    if (errorMessage.includes("UNIQUE constraint failed")) {
      if (errorMessage.includes("google_place_id")) {
        return NextResponse.json(
          { error: "A venue with this Google Place ID already exists" },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: "A venue with this name already exists" }, { status: 409 });
    }

    return NextResponse.json({ error: "Failed to update venue" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const db = getCloudflareDb();
  try {
    await db.delete(venues).where(eq(venues.id, id));
    return NextResponse.json({ success: true });
  } catch (error) {
    await logError(db, { message: "Failed to delete venue", error, source: "api/admin/venues/[id]", request });
    return NextResponse.json({ error: "Failed to delete venue" }, { status: 500 });
  }
}
