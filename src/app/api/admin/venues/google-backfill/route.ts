import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { venues } from "@/lib/db/schema";
import { eq, isNull } from "drizzle-orm";
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

    let success = 0;
    let failed = 0;
    let skipped = 0;

    for (const venue of missingGoogle) {
      const result = await lookupPlace(venue.name, venue.city, venue.state, apiKey);

      if (result && result.googlePlaceId) {
        const updates: Record<string, unknown> = {
          googlePlaceId: result.googlePlaceId,
          googleMapsUrl: result.googleMapsUrl,
          googleRating: result.googleRating,
          googleRatingCount: result.googleRatingCount,
          googleTypes: result.googleTypes,
          openingHours: result.openingHours,
          accessibility: result.accessibility,
          parking: result.parking,
          updatedAt: new Date(),
        };
        if (result.description) {
          updates.description = result.description;
        }
        if (result.photoUrl && !venue.imageUrl) {
          updates.imageUrl = result.photoUrl;
        }
        await db.update(venues).set(updates).where(eq(venues.id, venue.id));
        success++;
      } else if (result === null) {
        skipped++;
      } else {
        failed++;
      }

      // 200ms delay between calls
      await new Promise((r) => setTimeout(r, 200));
    }

    return NextResponse.json({ success, failed, skipped, total: missingGoogle.length });
  } catch (error) {
    await logError(db, {
      message: "Google Places backfill error",
      error,
      source: "api/admin/venues/google-backfill",
      request,
    });
    return NextResponse.json({ error: "Google backfill failed" }, { status: 500 });
  }
}
