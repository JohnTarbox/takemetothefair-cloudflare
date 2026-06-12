export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, syndicationSubscriptions } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { internalKeyMatches } from "@/lib/api-auth";
import { resolveSyndicationSubscriber } from "@/lib/syndication/auth";
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
//
// Auth (two ways):
//   • X-Internal-Key — MMATF-internal callers (full access to any event IDs).
//   • Authorization: Bearer <subscriber signing_secret> — Phase 2. A registered
//     consumer authenticates with their OWN secret (the same one that signs
//     their push webhooks), NOT MMATF's internal key. Results are SCOPED to the
//     events that subscriber is subscribed to — they can't read arbitrary IDs.

const MAX_EVENT_IDS = 200;
// D1 caps bound parameters at 100 per statement, so `IN (...)` reads are
// chunked below this to stay safe with the 200-ID request cap.
const ID_CHUNK = 90;

const bodySchema = z.object({
  eventIds: z.array(z.string().min(1)).min(1).max(MAX_EVENT_IDS),
});

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Narrow a requested ID set to those a subscriber actually tracks (chunked). */
async function subscribedEventIds(
  db: ReturnType<typeof getCloudflareDb>,
  subscriberId: string,
  requested: string[]
): Promise<Set<string>> {
  const allowed = new Set<string>();
  for (const ids of chunk(requested, ID_CHUNK)) {
    const rows = await db
      .select({ eventId: syndicationSubscriptions.eventId })
      .from(syndicationSubscriptions)
      .where(
        and(
          eq(syndicationSubscriptions.subscriberId, subscriberId),
          inArray(syndicationSubscriptions.eventId, ids)
        )
      );
    for (const r of rows) allowed.add(r.eventId);
  }
  return allowed;
}

/** Read mirrored event rows for the given IDs, chunked under D1's param cap. */
async function readEvents(db: ReturnType<typeof getCloudflareDb>, ids: string[]) {
  const rows: Array<{
    eventId: string;
    eventVersion: number;
    name: string;
    slug: string | null;
    startDate: Date | null;
    endDate: Date | null;
    venueName: string | null;
    venueAddress: string | null;
    venueCity: string | null;
    venueState: string | null;
    venueZip: string | null;
  }> = [];
  for (const part of chunk(ids, ID_CHUNK)) {
    const r = await db
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
      .where(inArray(events.id, part));
    rows.push(...r);
  }
  return rows;
}

/**
 * POST /api/internal/syndication/batch-read
 * Auth: X-Internal-Key OR Authorization: Bearer <subscriber signing_secret>.
 * Body: { eventIds: string[] } (≤200).
 * Returns: { events: [{ eventId, eventVersion, name, slug, startDate, endDate,
 *                        venue: { name, address, city, state, zip } | null }] }
 * Unknown (or, for a subscriber, un-subscribed) IDs are silently omitted.
 */
export async function POST(request: Request) {
  // Internal key first (no DB hit); else fall back to a subscriber bearer token.
  const isInternal = await internalKeyMatches(request);
  let subscriberId: string | null = null;
  if (!isInternal) {
    const subscriber = await resolveSyndicationSubscriber(request);
    if (!subscriber) {
      return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
    }
    subscriberId = subscriber.id;
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
    let ids = parsed.data.eventIds;
    // Subscriber callers only ever see events they're subscribed to.
    if (subscriberId) {
      const allowed = await subscribedEventIds(db, subscriberId, ids);
      ids = ids.filter((id) => allowed.has(id));
      if (ids.length === 0) {
        return NextResponse.json({ success: true, events: [] });
      }
    }

    const rows = await readEvents(db, ids);
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
