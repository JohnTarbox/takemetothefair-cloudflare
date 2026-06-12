export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { internalKeyMatches } from "@/lib/api-auth";
import { buildEventSnapshot } from "@takemetothefair/utils";
import { logError } from "@/lib/logger";

// SYN2 (Dev-Email-2026-06-12 §B) — reconcile backstop. Pure push (SYN1) can
// still lose a delivery (subscriber down past the retry/dead-letter window) and
// does nothing for snapshots that were ALREADY stale before SYN1 existed. This
// bulk read lets a consumer diff all its tracked event IDs in one call —
// `get_event_details` does the same per-entity, this is the efficient batch
// form for a nightly reconcile. Returns the mirrored field set + the per-event
// `eventVersion` so a consumer can self-heal any snapshot whose version lags.
//
// The reconcile loop itself runs on the CONSUMER side (business separation) —
// this endpoint is the only MMATF-side surface.

const MAX_EVENT_IDS = 200;

const bodySchema = z.object({
  eventIds: z.array(z.string().min(1)).min(1).max(MAX_EVENT_IDS),
});

/**
 * POST /api/internal/syndication/batch-read
 * Auth: X-Internal-Key. Body: { eventIds: string[] }.
 * Returns: { events: [{ eventId, eventVersion, name, slug, startDate, endDate,
 *                        venue: { name, address, city, state, zip } | null }] }
 * Unknown IDs are silently omitted (the consumer treats a missing ID as
 * deleted/unknown and handles it on its side).
 */
export async function POST(request: Request) {
  if (!(await internalKeyMatches(request))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "invalid_json" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "invalid_payload" }, { status: 400 });
  }

  const db = getCloudflareDb();
  try {
    const rows = await db
      .select({
        eventId: events.id,
        eventVersion: events.syndicationVersion,
        name: events.name,
        slug: events.slug,
        startDate: events.startDate,
        endDate: events.endDate,
        venueName: venues.name,
        venueAddress: venues.address,
        venueCity: venues.city,
        venueState: venues.state,
        venueZip: venues.zip,
      })
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(inArray(events.id, parsed.data.eventIds));

    const result = rows.map((r) => ({
      eventId: r.eventId,
      eventVersion: r.eventVersion,
      // buildEventSnapshot is the SAME shape the SYN1 push payload uses, so
      // pull and push never diverge.
      ...buildEventSnapshot(
        { name: r.name, slug: r.slug, startDate: r.startDate, endDate: r.endDate },
        r.venueName !== null ||
          r.venueAddress !== null ||
          r.venueCity !== null ||
          r.venueState !== null ||
          r.venueZip !== null
          ? {
              name: r.venueName,
              address: r.venueAddress,
              city: r.venueCity,
              state: r.venueState,
              zip: r.venueZip,
            }
          : null
      ),
    }));

    return NextResponse.json({ success: true, events: result });
  } catch (err) {
    await logError(db, {
      message: "SYN2 batch-read failed",
      error: err,
      source: "api/internal/syndication/batch-read",
      request,
    });
    return NextResponse.json({ success: false, error: "internal_error" }, { status: 500 });
  }
}
