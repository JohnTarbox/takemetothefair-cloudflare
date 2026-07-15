export const dynamic = "force-dynamic";
/**
 * OPE-207 — geocode specific venues by id, non-destructively.
 *
 * The main-app half of the `venues_geocode` MCP tool. The Google Places client
 * (`src/lib/google-maps.ts`) lives in this app and the MCP Worker is a separate
 * build with no path into `src/`, so the tool proxies here over X-Internal-Key
 * — the same shape `request_image_upload_slot` uses.
 *
 * ── Why not just use the existing routes ─────────────────────────────────
 * `/api/admin/venues/geocode` is a pure lookup that writes nothing, and
 * `/api/admin/venues/geocode-batch` is an all-venues-with-null-latitude sweep
 * that writes Google's top hit unconditionally, reports only success/failed
 * counts, and can't be aimed at specific ids. Both are admin-session-only, so
 * neither is reachable from the MCP Worker. Neither is safe for the job this
 * tool does.
 *
 * ── Why the confidence gate matters here specifically ────────────────────
 * These coordinates feed OPE-203, which attributes on-site photos to a fair by
 * finding venues within 1.5 miles of the photo's GPS. Google's fallback for a
 * miss is a CITY CENTROID (`location_type: APPROXIMATE`) — a confident-looking
 * pin that can sit miles from a rural fairground's gate. Stored, it silently
 * matches photos to the wrong venue or to none. So a low-confidence answer is
 * REPORTED, not written: "better a flagged blank than a wrong pin."
 *
 * Non-destructive by default: existing coordinates are never silently
 * overwritten (`force: true` opts in).
 */
import { NextResponse } from "next/server";
import { withInternalKey } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { venues } from "@/lib/db/schema";
import { eq, inArray, isNull, and } from "drizzle-orm";
import { geocodeAddressDetailed } from "@/lib/google-maps";
import { logError } from "@/lib/logger";
import {
  preflight,
  judge,
  type GeocodeOutcome,
  type VenueForGeocode,
} from "@/lib/venues/geocode-decision";

/**
 * Hard cap per call. Each venue costs one Google round-trip (8s timeout) plus a
 * pacing delay, and this route runs on the 100s edge budget — 25 × ~1s is a
 * comfortable fit while 233 in one shot is not. The caller pages.
 */
const MAX_PER_CALL = 25;

/** Pacing between Google calls — mirrors the existing geocode-batch route. */
const PACE_MS = 100;

interface Body {
  venue_id?: string;
  venue_ids?: string[];
  /** Re-geocode venues that already have coordinates. */
  force?: boolean;
  /** With no ids: geocode venues missing coordinates (capped at MAX_PER_CALL). */
  missing_only?: boolean;
  limit?: number;
}

export const POST = withInternalKey(
  { source: "api/admin/venues/geocode-venues" },
  async ({ request, db }) => {
    const body = (await request.json().catch(() => ({}))) as Body;
    const force = body.force === true;

    const env = getCloudflareEnv();
    const apiKey = env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Google Maps API key is not configured." },
        { status: 500 }
      );
    }

    const ids = [...(body.venue_id ? [body.venue_id] : []), ...(body.venue_ids ?? [])];
    const limit = Math.min(body.limit ?? MAX_PER_CALL, MAX_PER_CALL);

    const cols = {
      id: venues.id,
      name: venues.name,
      address: venues.address,
      city: venues.city,
      state: venues.state,
      zip: venues.zip,
      latitude: venues.latitude,
      longitude: venues.longitude,
    };

    let rows: VenueForGeocode[];
    if (ids.length > 0) {
      // inArray with >100 ids trips D1's SQL-variable limit; MAX_PER_CALL keeps
      // us well under, and the caller pages.
      rows = await db
        .select(cols)
        .from(venues)
        .where(inArray(venues.id, ids.slice(0, limit)));
    } else if (body.missing_only) {
      rows = await db
        .select(cols)
        .from(venues)
        .where(and(isNull(venues.latitude), isNull(venues.longitude)))
        .limit(limit);
    } else {
      return NextResponse.json(
        { error: "Provide venue_id, venue_ids, or missing_only:true." },
        { status: 400 }
      );
    }

    const results: GeocodeOutcome[] = [];
    // Report ids that matched no row rather than dropping them silently.
    const found = new Set(rows.map((r) => r.id));
    for (const missing of ids.slice(0, limit).filter((i) => !found.has(i))) {
      results.push({
        venue_id: missing,
        name: "(not found)",
        before: { lat: null, lng: null },
        after: { lat: null, lng: null, place_id: null },
        status: "error",
        error: "no such venue",
      });
    }

    for (const v of rows) {
      // Cheap outcomes first — no Google call for these.
      const pre = preflight(v, force);
      if (pre) {
        results.push(pre);
        continue;
      }

      try {
        const detail = await geocodeAddressDetailed(
          v.address ?? "",
          v.city ?? "",
          v.state ?? "",
          v.zip ?? undefined,
          apiKey
        );
        const outcome = judge(v, detail);

        if (outcome.status === "ok" && detail) {
          const updates: Record<string, unknown> = {
            latitude: detail.lat,
            longitude: detail.lng,
            googlePlaceId: detail.placeId,
            googleMapsUrl: `https://www.google.com/maps/place/?q=place_id:${detail.placeId}`,
            updatedAt: new Date(),
          };
          // Fill a blank zip from the geocode, but never overwrite a stored one.
          if (!v.zip && detail.zip) updates.zip = detail.zip;
          await db.update(venues).set(updates).where(eq(venues.id, v.id));
        }
        results.push(outcome);
      } catch (error) {
        // One venue's failure must not tank the batch (scope §5).
        await logError(db, {
          message: `Geocode failed for venue ${v.id}`,
          error,
          source: "api/admin/venues/geocode-venues",
          request,
        });
        results.push({
          venue_id: v.id,
          name: v.name,
          before: { lat: v.latitude, lng: v.longitude },
          after: { lat: null, lng: null, place_id: null },
          status: "error",
          error: error instanceof Error ? error.message : "geocode failed",
        });
      }

      await new Promise((r) => setTimeout(r, PACE_MS));
    }

    const summary = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});

    return NextResponse.json({ force, examined: results.length, summary, results });
  }
);
