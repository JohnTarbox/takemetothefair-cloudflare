/**
 * OPE-1079 — is a venue's new map pin implausibly far from its own town?
 *
 * The photo lane attributes on-site photos by GPS → venue pin (1.5 mi radius).
 * A geocoder pin that lands in the wrong place does not fail anywhere: it
 * silently makes every correctly-geotagged photo from that venue miss. The
 * New Portland Lions Fair pin sat 9.0 km off for a season; Waterford World's
 * Fair 3.8 km; "Downtown Phillips — Main Street" 7.1 km (written by
 * `venues_geocode` on 2026-08-22).
 *
 * There is no city-centroid table to check against (`locations` is empty,
 * OPE-425), so the cheapest available reference is **the other venues already
 * on file in the same city+state**. The check compares the new pin to the
 * coordinate-wise MEDIAN of those venues — a median, not a mean, so one bad
 * pin already in the town cannot drag the reference toward itself.
 *
 * ── Threshold: 10 km, measured ────────────────────────────────────────────
 * Prod, 2026-10-15: 560 pinned venues in towns with ≥3 pinned venues, each
 * measured against its town's median. p50 0.88 km · p90 4.08 · p95 5.19 ·
 * p99 7.99 · max 12.2 km. Two venues exceed 10 km today (South Middleboro
 * Grange, MA — a real village in a large town; Oquossoc Town Park, ME — where
 * the OTHER three Oquossoc pins share one fallback point, so it may be the
 * reference that is wrong). None exceed 15 km.
 *
 * 10 km sits above p99, so it flags ~0.4% of correct pins. That is cheap
 * because this NEVER blocks — it records a row and returns a warning. A
 * 15 km threshold flags nothing on today's data, which would make the check
 * decorative.
 *
 * ⚠️ Honest limit: on today's data this would NOT have caught any of the three
 * confirmed photo misses — New Portland and North Waterford have no other
 * pinned venue (check skips), and Phillips' 7.1 km is under threshold. Rural
 * Maine towns are ~10 km across, so a town-median check cannot see a wrong pin
 * that stays inside its own town. The photo-side signal
 * (`photo.gps_no_venue_in_range`) is what catches that class; this one catches
 * the gross geocoder failures (wrong town, wrong state, centroid fallback).
 */

/** Pins farther than this from their town's median are flagged. See header. */
export const PIN_TOWN_OUTLIER_KM = 10;

/** Fewer pinned peers than this and the median means nothing — skip. */
export const PIN_TOWN_MIN_PEERS = 2;

const EARTH_RADIUS_KM = 6371;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface PinTownCheck {
  /** True when the pin is more than `thresholdKm` from the town median. */
  far: boolean;
  distanceKm: number;
  medianLat: number;
  medianLng: number;
  /** How many OTHER pinned venues in the same town the median was built from. */
  peers: number;
  thresholdKm: number;
}

/**
 * Pure. `peers` are the OTHER venues in the same city+state (the caller
 * excludes the venue being written). Returns null when there are fewer than
 * `PIN_TOWN_MIN_PEERS` usable peers — no reference, no verdict.
 */
export function checkPinAgainstTown(
  pin: { lat: number; lng: number },
  peers: Array<{ lat: number | null; lng: number | null }>,
  thresholdKm = PIN_TOWN_OUTLIER_KM
): PinTownCheck | null {
  if (!Number.isFinite(pin.lat) || !Number.isFinite(pin.lng)) return null;
  const usable = peers.filter(
    (p): p is { lat: number; lng: number } =>
      typeof p.lat === "number" &&
      typeof p.lng === "number" &&
      Number.isFinite(p.lat) &&
      Number.isFinite(p.lng)
  );
  if (usable.length < PIN_TOWN_MIN_PEERS) return null;
  const medianLat = median(usable.map((p) => p.lat));
  const medianLng = median(usable.map((p) => p.lng));
  const distanceKm = haversineKm(pin.lat, pin.lng, medianLat, medianLng);
  return {
    far: distanceKm > thresholdKm,
    distanceKm: Math.round(distanceKm * 100) / 100,
    medianLat,
    medianLng,
    peers: usable.length,
    thresholdKm,
  };
}

/** The `admin_actions.action` written when a pin is flagged. One vocabulary
 *  for the main app and the MCP Worker, so a reader counts one action. */
export const VENUE_PIN_FAR_FROM_TOWN_ACTION = "venue.pin.far_from_town";

/** Operator-facing warning text for a flagged pin. */
export function pinTownWarning(
  check: PinTownCheck,
  town: { city: string | null; state: string | null }
): string {
  return (
    `Map pin is ${check.distanceKm} km from the median of ${check.peers} other venues in ` +
    `${town.city ?? "?"}, ${town.state ?? "?"} (threshold ${check.thresholdKm} km). ` +
    "Photo intake matches on-site photos by GPS within 1.5 mi of this pin, so a wrong pin " +
    "silently drops them. Verify the pin; fix with update_venue latitude/longitude if wrong."
  );
}
