/**
 * OPE-1079 — write-time sanity check for a venue pin (main-app side).
 *
 * Flags, never blocks: a pin implausibly far from the other venues already on
 * file in the same city+state records an `admin_actions` row
 * (`venue.pin.far_from_town`) and returns a warning the caller surfaces. The
 * verdict itself is the shared pure `checkPinAgainstTown` in
 * `@takemetothefair/utils` — the MCP Worker's `update_venue` uses the same one,
 * so the two write surfaces cannot drift apart. Threshold rationale lives there.
 */
import { and, isNotNull, ne, sql } from "drizzle-orm";
import { venues, adminActions } from "@/lib/db/schema";
import {
  checkPinAgainstTown,
  pinTownWarning,
  VENUE_PIN_FAR_FROM_TOWN_ACTION,
  type PinTownCheck,
} from "@takemetothefair/utils";

export interface VenuePinWrite {
  venueId: string;
  city: string | null;
  state: string | null;
  lat: number;
  lng: number;
  /** Which write path set the pin — lands in the audit payload. */
  source: string;
}

export interface PinSanityResult {
  check: PinTownCheck;
  warning: string;
}

/**
 * Check a pin that was just written and record a row when it is far from its
 * town. Returns the warning (or null when the pin is fine / no reference).
 *
 * Never throws: the pin is already stored, and an audit check must not be able
 * to fail the write it describes.
 */
export async function flagVenuePinIfFarFromTown(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  w: VenuePinWrite
): Promise<PinSanityResult | null> {
  const city = w.city?.trim();
  const state = w.state?.trim();
  if (!city || !state) return null;
  try {
    const peers: Array<{ lat: number | null; lng: number | null }> = await db
      .select({ lat: venues.latitude, lng: venues.longitude })
      .from(venues)
      .where(
        and(
          ne(venues.id, w.venueId),
          isNotNull(venues.latitude),
          isNotNull(venues.longitude),
          sql`lower(trim(${venues.city})) = ${city.toLowerCase()}`,
          sql`upper(trim(${venues.state})) = ${state.toUpperCase()}`
        )
      );
    const check = checkPinAgainstTown({ lat: w.lat, lng: w.lng }, peers);
    if (!check?.far) return null;
    const warning = pinTownWarning(check, { city, state });
    await db.insert(adminActions).values({
      action: VENUE_PIN_FAR_FROM_TOWN_ACTION,
      actorUserId: null,
      targetType: "venue",
      targetId: w.venueId,
      payloadJson: JSON.stringify({
        source: w.source,
        lat: w.lat,
        lng: w.lng,
        city,
        state,
        distance_km: check.distanceKm,
        town_median: { lat: check.medianLat, lng: check.medianLng },
        peers: check.peers,
        threshold_km: check.thresholdKm,
      }),
      createdAt: new Date(),
    });
    return { check, warning };
  } catch (e) {
    // Loud, not silent — but never fatal (see docblock).
    console.error("[pin-sanity] town check failed", w.venueId, e);
    return null;
  }
}
