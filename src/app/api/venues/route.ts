export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { geocodeNewVenue } from "@/lib/venues/geocode-one";
import { venues } from "@/lib/db/schema";
import { recordMutation } from "@/lib/audit/record-mutation";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { createSlug } from "@/lib/utils";
import { findVenueByGooglePlaceId } from "@/lib/queries";
import { logError } from "@/lib/logger";

export async function GET(request: Request) {
  const db = getCloudflareDb();
  try {
    const venueList = await db
      .select({
        id: venues.id,
        name: venues.name,
        city: venues.city,
        state: venues.state,
        googlePlaceId: venues.googlePlaceId,
        timezone: venues.timezone,
      })
      .from(venues)
      .where(eq(venues.status, "ACTIVE"))
      .orderBy(venues.name);

    return NextResponse.json(venueList);
  } catch (error) {
    await logError(db, { message: "Failed to fetch venues", error, source: "api/venues", request });
    return NextResponse.json({ error: "Failed to fetch venues" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Any authenticated user (ADMIN, PROMOTER, VENDOR) can create venues via Google
  const allowedRoles = ["ADMIN", "PROMOTER", "VENDOR"];
  if (!allowedRoles.includes(session.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    name: string;
    address: string;
    city: string;
    state: string;
    zip: string;
    latitude?: number | null;
    longitude?: number | null;
    contactPhone?: string | null;
    website?: string | null;
    description?: string | null;
    imageUrl?: string | null;
    googlePlaceId?: string | null;
    googleMapsUrl?: string | null;
    openingHours?: string | null;
    googleRating?: number | null;
    googleRatingCount?: number | null;
    googleTypes?: string | null;
    accessibility?: string | null;
    parking?: string | null;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.name || !body.address || !body.city || !body.state || !body.zip) {
    return NextResponse.json(
      { error: "name, address, city, state, and zip are required" },
      { status: 400 }
    );
  }

  const db = getCloudflareDb();

  try {
    // Check for duplicate Google Place ID
    if (body.googlePlaceId) {
      const existingVenue = await findVenueByGooglePlaceId(db, body.googlePlaceId);
      if (existingVenue) {
        return NextResponse.json(
          {
            error: `This venue already exists: "${existingVenue.name}" in ${existingVenue.city}, ${existingVenue.state}`,
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
      name: body.name,
      slug: createSlug(body.name),
      address: body.address,
      city: body.city,
      state: body.state,
      zip: body.zip,
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      amenities: "[]",
      contactPhone: body.contactPhone ?? null,
      website: body.website ?? null,
      description: body.description ?? null,
      imageUrl: body.imageUrl ?? null,
      googlePlaceId: body.googlePlaceId ?? null,
      googleMapsUrl: body.googleMapsUrl ?? null,
      openingHours: body.openingHours ?? null,
      googleRating: body.googleRating ?? null,
      googleRatingCount: body.googleRatingCount ?? null,
      googleTypes: body.googleTypes ?? null,
      accessibility: body.accessibility ?? null,
      parking: body.parking ?? null,
      status: "ACTIVE",
    });

    // OPE-433 scope 5 — the non-admin creation path. A promoter or vendor
    // creating a venue is the most common way a row with a wrong name or an
    // empty address enters the catalog (OPE-421), so who did it matters at
    // least as much here as on the admin route.
    await recordMutation(db, {
      entityType: "venue",
      entityId: venueId,
      verb: "create",
      actor: session.user.id,
      after: { name: body.name, address: body.address, city: body.city, state: body.state },
      note: `venue create via ${session.user.role}`,
    });

    // OPE-408 — geocode at creation. The public venue-create path had no
    // geocoding at all, so every venue born here started with NULL coordinates
    // and silently broke photo matching, distance/near-me and map surfaces
    // until a human swept by hand. Never fatal: geocodeNewVenue swallows every
    // fault, and the nightly sweep is the retry.
    await geocodeNewVenue(db, venueId, getCloudflareEnv().GOOGLE_MAPS_API_KEY);

    const [newVenue] = await db
      .select({
        id: venues.id,
        name: venues.name,
        city: venues.city,
        state: venues.state,
        googlePlaceId: venues.googlePlaceId,
        timezone: venues.timezone,
      })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);

    return NextResponse.json(newVenue, { status: 201 });
  } catch (error) {
    await logError(db, {
      message: "Failed to create venue",
      error,
      source: "api/venues/POST",
      request,
    });

    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes("UNIQUE constraint failed")) {
      if (errorMessage.includes("google_place_id")) {
        return NextResponse.json(
          { error: "A venue with this Google Place ID already exists" },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: "A venue with this name already exists. Try a different slug." },
        { status: 409 }
      );
    }

    return NextResponse.json({ error: "Failed to create venue" }, { status: 500 });
  }
}
