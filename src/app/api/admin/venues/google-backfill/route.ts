export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { recordMutation } from "@/lib/audit/record-mutation";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { venues } from "@/lib/db/schema";
import { eq, isNull, inArray, and } from "drizzle-orm";
import { lookupPlace } from "@/lib/google-maps";
import { logError } from "@/lib/logger";
import { createSlug } from "@/lib/utils";

export const POST = withAuth({ role: "ADMIN" }, async ({ request, db, session }) => {
  const env = getCloudflareEnv();
  const apiKey = env.GOOGLE_MAPS_API_KEY;

  try {
    const body = (await request.json().catch(() => ({}))) as { venueIds?: string[] };
    const venueIds = body.venueIds;

    // D1 has a limit on SQL bind variables, so cap the array
    if (venueIds && venueIds.length > 50) {
      return NextResponse.json(
        { error: "Too many venue IDs. Maximum 50 per request." },
        { status: 400 }
      );
    }

    const missingGoogle = await db
      .select()
      .from(venues)
      .where(
        venueIds?.length
          ? and(isNull(venues.googlePlaceId), inArray(venues.id, venueIds))
          : isNull(venues.googlePlaceId)
      );

    let success = 0;

    // OPE-294 — Places photos we declined to hotlink; reported so the skip is

    // visible in the response rather than silent.

    let skippedPhotos = 0;
    const allowPlacesPhotosReport = env.ALLOW_GOOGLE_PLACES_PHOTOS === "true";
    let failed = 0;
    let skipped = 0;

    for (const venue of missingGoogle) {
      const result = await lookupPlace(venue.name, venue.city, venue.state, apiKey, {
        address: venue.address || undefined,
        lat: venue.latitude ? Number(venue.latitude) : undefined,
        lng: venue.longitude ? Number(venue.longitude) : undefined,
      });

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
        if (result.name) {
          updates.name = result.name;
          updates.slug = createSlug(result.name);
        }
        if (result.description) {
          updates.description = result.description;
        }
        // OPE-294 scope 3 — STOP THE SOURCE.
        //
        // This line is where 172 of the 173 hotlinked venue images came from:
        // a Google Places photo URL written straight into `venues.image_url`
        // and served from Google's CDN on our public venue pages.
        //
        // Gated OFF by default rather than deleted. The licensing read is
        // John's and I have not pre-empted it — if he rules the practice is
        // fine with attribution, flipping `ALLOW_GOOGLE_PLACES_PHOTOS` to
        // "true" restores it in one line. What is NOT acceptable meanwhile is
        // the population growing while the question is open, and it was:
        // venue hotlinks 172 → 173 and event hotlinks 28 → 51 between the
        // ticket being filed and today.
        //
        // Skipping this leaves `imageUrl` null, which the og:image sweep
        // (admin-og-image-sweep) can later fill with bytes we actually own —
        // the pattern that already keeps events at 729 owned vs 51 hotlinked.
        const allowPlacesPhotos = env.ALLOW_GOOGLE_PLACES_PHOTOS === "true";
        if (result.photoUrl && !venue.imageUrl) {
          if (allowPlacesPhotos) {
            updates.imageUrl = result.photoUrl;
          } else {
            skippedPhotos++;
          }
        }
        await db.update(venues).set(updates).where(eq(venues.id, venue.id));
        // OPE-433 scope 5 — this sweep can overwrite `name` and `imageUrl` from
        // Google, which is exactly the OPE-421 shape (a venue's name replaced
        // by something else). An unattributed rename of a published venue is
        // the single hardest edit to reconstruct after the fact.
        await recordMutation(db, {
          entityType: "venue",
          entityId: venue.id,
          verb: "update",
          actor: session.user.id,
          before: { name: venue.name, imageUrl: venue.imageUrl },
          after: updates,
          note: "google places backfill sweep",
        });
        success++;
      } else if (result === null) {
        skipped++;
      } else {
        failed++;
      }

      // 200ms delay between calls
      await new Promise((r) => setTimeout(r, 200));
    }

    return NextResponse.json({
      success,
      failed,
      skipped,
      total: missingGoogle.length,
      // OPE-294 — surfaced rather than silent, so an operator running this can
      // see the policy acting instead of wondering why images stopped appearing.
      skippedPhotos,
      googlePlacesPhotosAllowed: allowPlacesPhotosReport,
    });
  } catch (error) {
    await logError(db, {
      message: "Google Places backfill error",
      error,
      source: "api/admin/venues/google-backfill",
      request,
    });
    return NextResponse.json({ error: "Google backfill failed" }, { status: 500 });
  }
});
