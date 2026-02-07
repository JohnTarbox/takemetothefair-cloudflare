import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { venues } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createSlug } from "@/lib/utils";
import { getVenuesWithEventCounts, findVenueByGooglePlaceId } from "@/lib/queries";
import { venueCreateSchema, validateRequestBody } from "@/lib/validations";
import { logError } from "@/lib/logger";

export const runtime = "edge";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getCloudflareDb();
  try {
    const venuesWithCounts = await getVenuesWithEventCounts(db);
    return NextResponse.json(venuesWithCounts);
  } catch (error) {
    await logError(db, { message: "Failed to fetch venues", error, source: "api/admin/venues", request });
    return NextResponse.json({ error: "Failed to fetch venues" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Validate request body
  const validation = await validateRequestBody(request, venueCreateSchema);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const data = validation.data;

  const db = getCloudflareDb();
  try {
    // Check for duplicate Google Place ID
    if (data.googlePlaceId) {
      const existingVenue = await findVenueByGooglePlaceId(db, data.googlePlaceId);
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

    const venueId = crypto.randomUUID();

    await db.insert(venues).values({
      id: venueId,
      name: data.name,
      slug: createSlug(data.name),
      address: data.address,
      city: data.city,
      state: data.state,
      zip: data.zip,
      latitude: data.latitude,
      longitude: data.longitude,
      capacity: data.capacity,
      amenities: JSON.stringify(data.amenities ?? []),
      contactEmail: data.contactEmail,
      contactPhone: data.contactPhone,
      website: data.website,
      description: data.description,
      imageUrl: data.imageUrl,
      googlePlaceId: data.googlePlaceId,
      googleMapsUrl: data.googleMapsUrl,
      openingHours: data.openingHours,
      googleRating: data.googleRating,
      googleRatingCount: data.googleRatingCount,
      googleTypes: data.googleTypes,
      accessibility: data.accessibility,
      parking: data.parking,
      status: data.status,
    });

    const [newVenue] = await db
      .select()
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);

    return NextResponse.json(newVenue, { status: 201 });
  } catch (error) {
    await logError(db, { message: "Failed to create venue", error, source: "api/admin/venues", request });

    // Provide more specific error messages
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes("UNIQUE constraint failed")) {
      if (errorMessage.includes("google_place_id")) {
        return NextResponse.json(
          { error: "A venue with this Google Place ID already exists" },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: "A venue with this name already exists" }, { status: 409 });
    }

    return NextResponse.json({ error: "Failed to create venue" }, { status: 500 });
  }
}
