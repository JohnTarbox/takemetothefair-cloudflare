export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { recordMutation } from "@/lib/audit/record-mutation";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { venues } from "@/lib/db/schema";
import { eq, isNull } from "drizzle-orm";
import { geocodeAddress } from "@/lib/google-maps";
import { logError } from "@/lib/logger";

export const POST = withAuth({ role: "ADMIN" }, async ({ request, db, session }) => {
  const env = getCloudflareEnv();
  const apiKey = env.GOOGLE_MAPS_API_KEY;

  try {
    const missingCoords = await db.select().from(venues).where(isNull(venues.latitude));

    let success = 0;
    let failed = 0;

    for (const venue of missingCoords) {
      const result = await geocodeAddress(
        venue.address,
        venue.city,
        venue.state,
        venue.zip || undefined,
        apiKey
      );

      if (result) {
        const updates: Record<string, unknown> = {
          latitude: result.lat,
          longitude: result.lng,
          updatedAt: new Date(),
        };
        if (!venue.zip && result.zip) {
          updates.zip = result.zip;
        }
        await db.update(venues).set(updates).where(eq(venues.id, venue.id));
        // OPE-433 scope 5 — the sweep that is a prime suspect for the ticket's
        // 04:00:20Z specimen now says so itself. Actor is the admin who ran it:
        // a sweep has no intent of its own, and the accountable party is the
        // person who started it.
        await recordMutation(db, {
          entityType: "venue",
          entityId: venue.id,
          verb: "update",
          actor: session.user.id,
          before: { latitude: venue.latitude, longitude: venue.longitude, zip: venue.zip },
          after: updates,
          note: "venues geocode-batch sweep",
        });
        success++;
      } else {
        failed++;
      }

      // 100ms delay between calls
      await new Promise((r) => setTimeout(r, 100));
    }

    return NextResponse.json({ success, failed, total: missingCoords.length });
  } catch (error) {
    await logError(db, {
      message: "Batch geocode error",
      error,
      source: "api/admin/venues/geocode-batch",
      request,
    });
    return NextResponse.json({ error: "Batch geocode failed" }, { status: 500 });
  }
});
