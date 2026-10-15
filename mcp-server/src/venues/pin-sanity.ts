/**
 * OPE-1079 — write-time venue pin sanity check, MCP-Worker side.
 *
 * Mirrors `src/lib/venues/pin-sanity.ts` (main app). The VERDICT is the one
 * shared pure function `checkPinAgainstTown` in `@takemetothefair/utils`, so
 * the two surfaces cannot disagree about what "too far" means; only the D1
 * read + audit insert are duplicated, because the Worker cannot import `src/`.
 *
 * Flags, never blocks. Never throws: the pin is already stored.
 */
import { and, isNotNull, ne, sql } from "drizzle-orm";
import {
  checkPinAgainstTown,
  pinTownWarning,
  VENUE_PIN_FAR_FROM_TOWN_ACTION,
  type PinTownCheck,
} from "@takemetothefair/utils";
import type { Db } from "../db.js";
import { adminActions, venues } from "../schema.js";

export interface VenuePinWrite {
  venueId: string;
  city: string | null;
  state: string | null;
  lat: number;
  lng: number;
  source: string;
  actorUserId?: string | null;
}

export async function flagVenuePinIfFarFromTown(
  db: Db,
  w: VenuePinWrite
): Promise<{ check: PinTownCheck; warning: string } | null> {
  const city = w.city?.trim();
  const state = w.state?.trim();
  if (!city || !state) return null;
  try {
    const peers = await db
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
      actorUserId: w.actorUserId ?? null,
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
    } as never);
    return { check, warning };
  } catch (e) {
    console.error("[pin-sanity] town check failed", w.venueId, e);
    return null;
  }
}
