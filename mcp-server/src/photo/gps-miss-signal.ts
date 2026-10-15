/**
 * OPE-1079 — a correctly geotagged photo that matched no fair must raise a
 * signal a human reads.
 *
 * 2026-09-18: four New Portland Lions Fair photos carried clean GPS fixes
 * (agreeing within ~45 m), the fair was APPROVED and running that day, and all
 * four held as `no-venue-in-radius` — because the venue's Google Places pin was
 * 9.0 km off. The lane replied politely and NOTHING ELSE recorded that a
 * geotagged photo had missed. That is OPE-403's silent-degradation shape: a
 * reason that only the sender ever saw.
 *
 * A held photo WITH valid GPS is strictly more actionable than one without:
 * its fix is free ground truth for a venue pin. The OPE-1079 audit of the held
 * set (48 rows) found 26 GPS-bearing holds; 15 of them were pin defects at the
 * event's own venue (Waterford 3.8 km, New Portland 9.0 km) and 2 more at the
 * event's venue 7.1 km off (Phillips, a `no-event-on-date` hold — a venue
 * in range existed, but not the one the event is filed under).
 *
 * So both GPS-bearing "we looked and could not find it" reasons signal:
 *   - `no-venue-in-radius` → `photo.gps_no_venue_in_range`
 *   - `no-event-on-date`   → `photo.gps_no_event_on_date`
 * Not `ambiguous-multiple-events` (we found candidates; the human names one)
 * and never the no-GPS reasons (no fix → nothing to act on; (0,0) is already
 * rejected by `parseExif` as Null Island).
 *
 * What the row carries is what the reviewer needs to act WITHOUT re-reading
 * EXIF: the fix, the capture date, the nearest pinned venues with distance,
 * and the public events running that day within NEARBY_KM — with their own
 * venue's distance from the fix. A running event whose venue is 4–10 km away
 * is the pin-defect fingerprint.
 *
 * Signal only: no reply copy changes, no pin is moved. Fail-soft: a signal
 * that cannot be written must not cost the photo its hold reply.
 */
import { and, eq, gte, isNotNull, lte } from "drizzle-orm";
import type { Db } from "../db.js";
import { adminActions, inboundEmails, venues } from "../schema.js";
import { haversineMiles, type EventCandidate, type HoldReason } from "./resolve-occurrence.js";

export const GPS_NO_VENUE_IN_RANGE_ACTION = "photo.gps_no_venue_in_range";
export const GPS_NO_EVENT_ON_DATE_ACTION = "photo.gps_no_event_on_date";

/** How far around the fix we look for context. Wider than any pin defect seen
 *  (9.0 km), narrow enough that the list stays about one area. */
export const NEARBY_KM = 25;

const KM_PER_MILE = 1.609344;
const KM_PER_DEG_LAT = 111.2;

/**
 * Pure: which signal (if any) does this hold earn? Needs a real fix AND a
 * capture date — without the date there is no "running that day".
 */
export function gpsMissAction(
  reason: HoldReason,
  exif: { gps?: { latitude: number; longitude: number }; takenOnLocalDate?: string }
): string | null {
  if (!exif.gps || !exif.takenOnLocalDate) return null;
  const { latitude, longitude } = exif.gps;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude === 0 && longitude === 0) return null; // belt-and-braces: Null Island
  if (reason === "no-venue-in-radius") return GPS_NO_VENUE_IN_RANGE_ACTION;
  if (reason === "no-event-on-date") return GPS_NO_EVENT_ON_DATE_ACTION;
  return null;
}

export interface GpsMissContext {
  lat: number;
  lng: number;
  taken_on_local_date: string;
  hold_reason: HoldReason;
  nearest_venues: Array<{ id: string; name: string; town: string; distance_km: number }>;
  events_running_nearby: Array<{
    id: string;
    name: string;
    slug: string;
    venue_id: string | null;
    venue_name: string | null;
    town: string;
    venue_distance_km: number | null;
  }>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Write the signal for one held email: an `admin_actions` row + the existing
 * `/admin/inbound-emails` review flag. Idempotent per (action, email) — the
 * dispatch step can be retried, and a second row would read as a second miss.
 *
 * `loadEventsAt` is the handler's own `loadCandidateEvents`, injected so the
 * "running that day" judgement is the matcher's, not a lookalike.
 */
export async function recordGpsMissSignal(
  db: Db,
  args: {
    inboundEmailId: string;
    reason: HoldReason;
    gps: { latitude: number; longitude: number };
    takenOnLocalDate: string;
    loadEventsAt: (venueIds: string[], localDate: string) => Promise<EventCandidate[]>;
  }
): Promise<GpsMissContext | null> {
  const action = gpsMissAction(args.reason, {
    gps: args.gps,
    takenOnLocalDate: args.takenOnLocalDate,
  });
  if (!action) return null;

  try {
    const [existing] = await db
      .select({ id: adminActions.id })
      .from(adminActions)
      .where(and(eq(adminActions.action, action), eq(adminActions.targetId, args.inboundEmailId)))
      .limit(1);
    if (existing) return null;

    const { latitude: lat, longitude: lng } = args.gps;
    const dLat = NEARBY_KM / KM_PER_DEG_LAT;
    const dLon = NEARBY_KM / (KM_PER_DEG_LAT * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
    const rows = await db
      .select({
        id: venues.id,
        name: venues.name,
        city: venues.city,
        state: venues.state,
        latitude: venues.latitude,
        longitude: venues.longitude,
      })
      .from(venues)
      .where(
        and(
          isNotNull(venues.latitude),
          isNotNull(venues.longitude),
          gte(venues.latitude, lat - dLat),
          lte(venues.latitude, lat + dLat),
          gte(venues.longitude, lng - dLon),
          lte(venues.longitude, lng + dLon)
        )
      );

    const near = rows
      .flatMap((v) =>
        v.latitude === null || v.longitude === null
          ? []
          : [
              {
                ...v,
                km: haversineMiles(lat, lng, v.latitude, v.longitude) * KM_PER_MILE,
              },
            ]
      )
      .filter((v) => v.km <= NEARBY_KM)
      .sort((a, b) => a.km - b.km);
    const byId = new Map(near.map((v) => [v.id, v]));
    const town = (v: { city: string | null; state: string | null } | undefined) =>
      v ? [v.city, v.state].filter(Boolean).join(", ") : "";

    const events = near.length
      ? (await args.loadEventsAt([...byId.keys()], args.takenOnLocalDate)).filter((e) =>
          e.dates.includes(args.takenOnLocalDate)
        )
      : [];

    const context: GpsMissContext = {
      lat,
      lng,
      taken_on_local_date: args.takenOnLocalDate,
      hold_reason: args.reason,
      nearest_venues: near.slice(0, 5).map((v) => ({
        id: v.id,
        name: v.name,
        town: town(v),
        distance_km: round2(v.km),
      })),
      events_running_nearby: events
        .map((e) => {
          const v = e.venueId ? byId.get(e.venueId) : undefined;
          return {
            id: e.id,
            name: e.name,
            slug: e.slug,
            venue_id: e.venueId,
            venue_name: v?.name ?? null,
            town: town(v),
            venue_distance_km: v ? round2(v.km) : null,
          };
        })
        .sort((a, b) => (a.venue_distance_km ?? 1e9) - (b.venue_distance_km ?? 1e9))
        .slice(0, 10),
    };

    await db.insert(adminActions).values({
      action,
      actorUserId: null,
      targetType: "inbound_email",
      targetId: args.inboundEmailId,
      payloadJson: JSON.stringify(context),
      createdAt: new Date(),
    } as never);
    await db
      .update(inboundEmails)
      .set({ flaggedForReview: 1 })
      .where(eq(inboundEmails.id, args.inboundEmailId));
    return context;
  } catch (e) {
    // Fail-soft, but loud: the hold reply still goes out.
    console.error("[photo-intake] gps-miss signal failed", args.inboundEmailId, e);
    return null;
  }
}
