export const dynamic = "force-dynamic";
/**
 * OPE-207 — geocode specific venues by id, non-destructively.
 *
 * ── Two lookup paths (OPE-213) ───────────────────────────────────────────
 * A venue WITH a street address → Geocoding API (`judge`).
 * A venue with only name + city + state → Places TEXT SEARCH (`judgeNameLookup`),
 * which also back-fills the missing street address. Without this, the 38
 * addressless landmarks blocking OPE-203's photo lane (Tanglewood, MASS MoCA,
 * Jacob's Pillow…) returned `insufficient-address` forever — they were never
 * missing data a human had to research, only being asked the wrong question.
 * The two paths gate differently because the two APIs return different
 * evidence; see `judgeNameLookup`.
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
 * overwritten, and a low-confidence pin is reported rather than stored.
 *
 * `force: true` opts into BOTH overrides — re-geocoding an already-pinned
 * venue, and storing a low-confidence candidate the operator has reviewed
 * (OPE-215; before that fix `force` reached `preflight` only, so the documented
 * escape hatch silently did nothing). A forced write is reported as `forced`,
 * never as a clean `ok`, and leaves an `admin_actions` row.
 */
import { NextResponse } from "next/server";
import { withInternalKey } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { venues, adminActions } from "@/lib/db/schema";
import { inArray, isNull, and, gt } from "drizzle-orm";
import { logError } from "@/lib/logger";
import { geocodeVenueRow } from "@/lib/venues/geocode-one";
import {
  nextCursor,
  type GeocodeOutcome,
  type VenueForGeocode,
} from "@/lib/venues/geocode-decision";

/**
 * Hard cap per call. Each venue costs one Google round-trip (8s timeout) plus a
 * pacing delay, and this route runs on the 100s edge budget — 25 × ~1s is a
 * comfortable fit while 233 in one shot is not. The caller pages via
 * `after_id` / `next_cursor` (OPE-214).
 *
 * The OPE-213 name path is pricier: `lookupPlace` also fetches a photo URL for
 * a hit that has photos, so budget ~2 round-trips per addressless venue. Still
 * inside the budget at 25, but page smaller if a name-heavy batch runs long.
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
  /**
   * OPE-214 — keyset cursor for `missing_only`: resume after this venue id.
   * Pass back the `next_cursor` from the previous response; omit to start.
   */
  after_id?: string;
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
      // OPE-214 — keyset paging. The ORDER BY is not cosmetic: without a stable
      // order the cursor is meaningless, and without the cursor a non-writing
      // outcome matches this same filter on every call and can be handed back
      // forever (the original stall).
      rows = await db
        .select(cols)
        .from(venues)
        .where(
          and(
            isNull(venues.latitude),
            isNull(venues.longitude),
            body.after_id ? gt(venues.id, body.after_id) : undefined
          )
        )
        .orderBy(venues.id)
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
      // OPE-408 — the per-venue decision + write now lives in
      // src/lib/venues/geocode-one.ts, because venue CREATION needs the exact
      // same confidence gate. It had been inline here only, which is why five
      // hardening passes (OPE-213/214/215/219/228) improved the sweep and left
      // every newly-created venue ungeocoded. One gate, two callers.
      try {
        results.push(await geocodeVenueRow(db, v, apiKey, force));
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

    // OPE-214 — only `missing_only` pages; an explicit id list is already the
    // caller's own cursor. Loop until this comes back null.
    const next_cursor = body.missing_only ? nextCursor(rows, limit) : null;

    // OPE-408 — record that the SWEEP RAN, not just what it wrote.
    //
    // This is the observability half the original OPE-408 ship missed, and it
    // is the OPE-246 "shipped but silently not executing" class exactly. Until
    // now the only D1 trace of a nightly sweep was the `venue.update` row each
    // SUCCESSFUL geocode leaves — a YIELD, not a run. On a night where every
    // remaining venue is refused (low-confidence, non-point, duplicate-place),
    // a healthy sweep and a dead cron are byte-for-byte identical in the
    // database, and the only success signal is a `console.log` nobody can
    // query. Two of the last ten nights wrote nothing; neither is
    // distinguishable from an outage today.
    //
    // Only for `missing_only` — an explicit id list is somebody calling the
    // tool by hand, which is not the cron and must not refresh its liveness.
    if (body.missing_only) {
      try {
        await db.insert(adminActions).values({
          action: "venue.geocode.sweep",
          // `target_id` is NOT NULL and a sweep has no single target. The
          // literal names the run rather than pointing at a row, and keeps the
          // (target_type, target_id) index usable for "show me every sweep".
          targetType: "venue",
          targetId: "sweep",
          createdAt: new Date(),
          payloadJson: JSON.stringify({
            attempted: results.length,
            written: summary.ok ?? 0,
            summary,
            next_cursor,
          }),
        });
      } catch {
        // A liveness row must never fail the sweep it describes — same
        // contract as `recordMutation`. A missed row reads as one late night,
        // and the 48h probe window absorbs it.
      }
    }

    return NextResponse.json({ force, examined: results.length, summary, next_cursor, results });
  }
);
