/**
 * OPE-1341 — "You're at: <event>" for the snap page's event pin.
 *
 * The same venue × date rule the photo resolver uses (mcp-server
 * photo/resolve-occurrence.ts): public events (PUBLIC_EVENT_STATUSES — OPE-1337),
 * not tombstoned, at a geocoded venue near the phone, running on the phone's
 * local date per `event_days` or, without day rows, the start→end range.
 *
 * This only SUGGESTS a pin. The server still resolves every snap through the
 * photo-intake handler; a pinned event travels as the existing plus-address
 * override, exactly as `photos+<slug>@` does for email.
 */
import { and, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { PUBLIC_EVENT_STATUSES } from "@takemetothefair/constants";
import { eventDays, events, venues } from "@/lib/db/schema";
import { haversineDistance } from "@/lib/geo";
import type { getCloudflareDb } from "@/lib/cloudflare";

type Db = ReturnType<typeof getCloudflareDb>;

/** The resolver's own radius: inside this, the photo was taken AT the venue. */
export const SNAP_AT_VENUE_MILES = 1.5;
/** How far out the override list looks, for a pin that is off by a field. */
export const SNAP_NEARBY_MILES = 10;
const MILES_PER_DEG_LAT = 69;
/** Longest event we expect a single start date to cover (the resolver's cap). */
const MAX_EVENT_SPAN_DAYS = 60;

export interface NearbyEvent {
  id: string;
  slug: string;
  name: string;
  venueName: string;
  distanceMiles: number;
  /** Within SNAP_AT_VENUE_MILES — what the resolver would match by GPS. */
  atVenue: boolean;
}

/** Pure: does this event run on `localDate`? Mirrors expandEventDates. */
export function runsOn(
  localDate: string,
  dayDates: string[],
  startDate: Date | null,
  endDate: Date | null
): boolean {
  if (dayDates.length > 0) return dayDates.includes(localDate);
  if (!startDate) return false;
  const day = Date.parse(`${localDate}T00:00:00Z`);
  const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return day >= utcDay(startDate) && day <= utcDay(endDate ?? startDate);
}

export async function findNearbyEvents(
  db: Db,
  at: { latitude: number; longitude: number },
  localDate: string
): Promise<NearbyEvent[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) return [];
  const dLat = SNAP_NEARBY_MILES / MILES_PER_DEG_LAT;
  const cos = Math.max(0.01, Math.cos((at.latitude * Math.PI) / 180));
  const dLon = SNAP_NEARBY_MILES / (MILES_PER_DEG_LAT * cos);

  const near = await db
    .select({
      id: venues.id,
      name: venues.name,
      latitude: venues.latitude,
      longitude: venues.longitude,
    })
    .from(venues)
    .where(
      and(
        isNotNull(venues.latitude),
        isNotNull(venues.longitude),
        gte(venues.latitude, at.latitude - dLat),
        lte(venues.latitude, at.latitude + dLat),
        gte(venues.longitude, at.longitude - dLon),
        lte(venues.longitude, at.longitude + dLon)
      )
    )
    .limit(90); // stays under D1's 100-bound-parameter cap in the IN() below
  const venueById = new Map(
    near
      .filter((v) => v.latitude !== null && v.longitude !== null)
      .map((v) => [
        v.id,
        {
          name: v.name,
          miles: haversineDistance(at.latitude, at.longitude, v.latitude!, v.longitude!),
        },
      ])
  );
  const inRange = [...venueById.entries()].filter(([, v]) => v.miles <= SNAP_NEARBY_MILES);
  if (inRange.length === 0) return [];

  const dayMs = Date.parse(`${localDate}T00:00:00Z`);
  const rows = await db
    .select({
      id: events.id,
      slug: events.slug,
      name: events.name,
      venueId: events.venueId,
      startDate: events.startDate,
      endDate: events.endDate,
    })
    .from(events)
    .where(
      and(
        inArray(
          events.venueId,
          inRange.map(([id]) => id)
        ),
        inArray(events.status, [...PUBLIC_EVENT_STATUSES]),
        isNull(events.mergedInto),
        gte(events.startDate, new Date(dayMs - MAX_EVENT_SPAN_DAYS * 86_400_000)),
        lte(events.startDate, new Date(dayMs + 86_400_000))
      )
    );
  if (rows.length === 0) return [];

  const days = await db
    .select({ eventId: eventDays.eventId, date: eventDays.date })
    .from(eventDays)
    .where(
      inArray(
        eventDays.eventId,
        rows.map((r) => r.id)
      )
    );
  const daysByEvent = new Map<string, string[]>();
  for (const d of days) daysByEvent.set(d.eventId, [...(daysByEvent.get(d.eventId) ?? []), d.date]);

  return rows
    .filter((r) => runsOn(localDate, daysByEvent.get(r.id) ?? [], r.startDate, r.endDate))
    .map((r) => {
      const v = venueById.get(r.venueId!)!;
      const miles = Math.round(v.miles * 100) / 100;
      return {
        id: r.id,
        slug: r.slug,
        name: r.name,
        venueName: v.name,
        distanceMiles: miles,
        atVenue: miles <= SNAP_AT_VENUE_MILES,
      };
    })
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, 12);
}
