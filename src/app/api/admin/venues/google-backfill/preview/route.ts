import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { venues } from "@/lib/db/schema";
import { isNull } from "drizzle-orm";
import { lookupPlace } from "@/lib/google-maps";
import { logError } from "@/lib/logger";

export const runtime = "edge";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getCloudflareDb();
  const env = getCloudflareEnv();
  const apiKey = env.GOOGLE_MAPS_API_KEY;

  try {
    const missingGoogle = await db
      .select()
      .from(venues)
      .where(isNull(venues.googlePlaceId));

    const previews: {
      venueId: string;
      venueName: string;
      venueCity: string;
      venueState: string;
      googleName: string | null;
      googlePlaceId: string | null;
      googleRating: number | null;
      googleAddress: string | null;
      photoUrl: string | null;
    }[] = [];

    for (const venue of missingGoogle) {
      const result = await lookupPlace(venue.name, venue.city, venue.state, apiKey, {
        address: venue.address || undefined,
        lat: venue.latitude ? Number(venue.latitude) : undefined,
        lng: venue.longitude ? Number(venue.longitude) : undefined,
      });

      if (result && result.googlePlaceId) {
        previews.push({
          venueId: venue.id,
          venueName: venue.name,
          venueCity: venue.city,
          venueState: venue.state,
          googleName: result.name,
          googlePlaceId: result.googlePlaceId,
          googleRating: result.googleRating,
          googleAddress: result.formattedAddress,
          photoUrl: result.photoUrl,
        });
      }

      await new Promise((r) => setTimeout(r, 200));
    }

    return NextResponse.json(previews);
  } catch (error) {
    await logError(db, {
      message: "Google Places backfill preview error",
      error,
      source: "api/admin/venues/google-backfill/preview",
      request,
    });
    return NextResponse.json({ error: "Google backfill preview failed" }, { status: 500 });
  }
}
