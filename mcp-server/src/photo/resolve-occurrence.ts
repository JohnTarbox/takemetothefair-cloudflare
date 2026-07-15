/**
 * OPE-203 — pure resolver: which fair occurrence is this photo from?
 *
 * A fair is a **venue × date**. GPS alone is ambiguous (a fairground hosts many
 * shows a year), and a date alone is ambiguous (many fairs run the same
 * weekend) — together they pin one occurrence. This module owns that judgment
 * and nothing else: no R2, no D1, no I/O. The handler feeds it rows and it
 * returns a verdict, so the risky part (attributing a photo to the WRONG fair)
 * is exhaustively unit-testable.
 *
 * DESIGN RULE — never guess. Every ambiguous or thin case resolves to `held`
 * with a reason the reply can quote. A wrong silent attribution would link a
 * vendor to a fair they never attended (the OPE-204 tail writes on this
 * verdict), which is far worse than asking John to name the fair.
 */

/** A geocoded venue candidate. Non-geocoded venues never reach here. */
export interface VenueCandidate {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

/** An occurrence at one of the candidate venues. */
export interface EventCandidate {
  id: string;
  name: string;
  slug: string;
  venueId: string | null;
  /** Local "YYYY-MM-DD" dates this event runs. From event_days, or derived
   *  from the start/end range when the event has no per-day rows. */
  dates: string[];
}

export type HoldReason =
  | "no-exif-gps"
  | "no-exif-date"
  | "no-venue-in-radius"
  | "no-event-on-date"
  | "ambiguous-multiple-events";

export type Resolution =
  | {
      status: "resolved";
      eventId: string;
      eventName: string;
      eventSlug: string;
      /** How we got there — surfaced in the reply so John can sanity-check. */
      method: "override" | "exif";
      /** Miles from the photo to the matched venue. Absent for overrides. */
      distanceMiles?: number;
      venueName?: string;
      matchedDate?: string;
    }
  | {
      status: "held";
      reason: HoldReason;
      /** Human-readable detail for the reply (e.g. the competing fairs). */
      detail?: string;
    };

/**
 * Radius for "this photo was taken AT this venue".
 *
 * 1.5 miles is deliberately generous relative to consumer-GPS error (~10m):
 * the real driver is that a venue's stored lat/lng is a single point
 * (often the street address or a geocoder centroid) while a fairground can
 * span half a mile, and a booth may sit at the far end of it. Too tight and a
 * legitimate photo from the back field misses; too loose and a neighbouring
 * venue in the same town becomes a candidate. The uniqueness check below is
 * what actually prevents a wrong answer, so this can afford to be inclusive.
 */
export const VENUE_RADIUS_MILES = 1.5;

const EARTH_RADIUS_MILES = 3959;

/**
 * Great-circle distance in miles.
 *
 * Duplicated from `src/lib/geo.ts` by necessity: that module lives in the main
 * Next app and the MCP Worker is a separate build with no path into `src/`.
 * Keep the two in sync if either changes (same formula, same radius constant).
 */
export function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Venues within VENUE_RADIUS_MILES of the photo, nearest first. */
export function venuesWithinRadius(
  gps: { latitude: number; longitude: number },
  venues: VenueCandidate[],
  radiusMiles = VENUE_RADIUS_MILES
): Array<VenueCandidate & { distanceMiles: number }> {
  return venues
    .map((v) => ({
      ...v,
      distanceMiles: haversineMiles(gps.latitude, gps.longitude, v.latitude, v.longitude),
    }))
    .filter((v) => v.distanceMiles <= radiusMiles)
    .sort((a, b) => a.distanceMiles - b.distanceMiles);
}

export interface ResolveInput {
  /** Explicit override: the event named by `photos+<slug>@` or the subject. */
  overrideEvent?: { id: string; name: string; slug: string } | null;
  gps?: { latitude: number; longitude: number };
  /** Local "YYYY-MM-DD" from EXIF DateTimeOriginal. */
  takenOnLocalDate?: string;
  /** Geocoded venues to consider (caller pre-filters to lat/lng NOT NULL). */
  venues: VenueCandidate[];
  /** Occurrences at those venues. */
  events: EventCandidate[];
  radiusMiles?: number;
}

/**
 * Decide which occurrence a photo belongs to.
 *
 * Order (first confident hit wins):
 *   1. explicit override (plus-address / subject) — trusted, skips matching
 *   2. EXIF GPS → venues in radius → the occurrence running on the EXIF date
 *   3. otherwise → hold with a reason
 */
export function resolveOccurrence(input: ResolveInput): Resolution {
  // ── 1. Explicit override wins ─────────────────────────────────────────
  // John naming the fair beats any inference we could make, and skips EXIF
  // entirely — that's the documented escape hatch when a photo has no GPS.
  if (input.overrideEvent) {
    return {
      status: "resolved",
      eventId: input.overrideEvent.id,
      eventName: input.overrideEvent.name,
      eventSlug: input.overrideEvent.slug,
      method: "override",
    };
  }

  // ── 2. EXIF path ──────────────────────────────────────────────────────
  if (!input.gps) return { status: "held", reason: "no-exif-gps" };
  if (!input.takenOnLocalDate) return { status: "held", reason: "no-exif-date" };

  const near = venuesWithinRadius(input.gps, input.venues, input.radiusMiles);
  if (near.length === 0) return { status: "held", reason: "no-venue-in-radius" };

  const nearById = new Map(near.map((v) => [v.id, v]));
  const date = input.takenOnLocalDate;

  // Consider occurrences at EVERY venue in radius, not just the nearest.
  // Two venues can sit within the radius of one another (a fairground and its
  // adjacent arena), and the stored point may be closer to the wrong one; the
  // DATE is the sharper discriminator. Requiring a unique date hit across all
  // nearby venues is both more forgiving and safer than trusting "nearest".
  const matches = input.events.filter(
    (e) => e.venueId !== null && nearById.has(e.venueId) && e.dates.includes(date)
  );

  if (matches.length === 0) return { status: "held", reason: "no-event-on-date" };

  if (matches.length > 1) {
    return {
      status: "held",
      reason: "ambiguous-multiple-events",
      detail: matches.map((m) => m.name).join(", "),
    };
  }

  const match = matches[0];
  const venue = match.venueId ? nearById.get(match.venueId) : undefined;
  return {
    status: "resolved",
    eventId: match.id,
    eventName: match.name,
    eventSlug: match.slug,
    method: "exif",
    distanceMiles: venue ? Math.round(venue.distanceMiles * 100) / 100 : undefined,
    venueName: venue?.name,
    matchedDate: date,
  };
}

/**
 * Expand an event's date coverage to local "YYYY-MM-DD" strings.
 *
 * Prefers explicit `event_days` rows (authoritative — they encode closures and
 * vendor-only days). Falls back to walking the start→end range for events that
 * predate per-day rows. Capped at 60 days so a bad end-date can't spin.
 */
export function expandEventDates(
  eventDayDates: string[],
  startDate: Date | null,
  endDate: Date | null
): string[] {
  if (eventDayDates.length > 0) return eventDayDates;
  if (!startDate) return [];
  const out: string[] = [];
  const end = endDate ?? startDate;
  const cursor = new Date(
    Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate())
  );
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  let guard = 0;
  while (cursor.getTime() <= last && guard++ < 60) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}
