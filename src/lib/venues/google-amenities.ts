/**
 * Google Places accessibility / parking options, as stored on
 * `venues.accessibility` / `venues.parking` (JSON objects of boolean flags,
 * e.g. `{"wheelchairAccessibleEntrance":true}`), turned into plain phrases.
 *
 * One table of labels for every page that shows them — the venue page and,
 * since OPE-1479, the event page's "Visiting" box — so the two cannot drift.
 */

export const GOOGLE_ACCESSIBILITY_LABELS: Record<string, string> = {
  wheelchairAccessibleParking: "Wheelchair accessible parking",
  wheelchairAccessibleEntrance: "Wheelchair accessible entrance",
  wheelchairAccessibleRestroom: "Wheelchair accessible restroom",
  wheelchairAccessibleSeating: "Wheelchair accessible seating",
};

export const GOOGLE_PARKING_LABELS: Record<string, string> = {
  freeParkingLot: "Free parking lot",
  paidParkingLot: "Paid parking lot",
  freeStreetParking: "Free street parking",
  paidStreetParking: "Paid street parking",
  valetParking: "Valet parking",
  freeGarageParking: "Free garage parking",
  paidGarageParking: "Paid garage parking",
};

/**
 * The phrases for every flag that is exactly `true`. A `false` flag is Google
 * saying "no", which is not something to advertise; an unknown key falls back
 * to its camelCase split. Malformed JSON → no phrases (never throws).
 */
export function googleAmenityPhrases(
  json: string | null | undefined,
  labels: Record<string, string>
): string[] {
  if (!json) return [];
  try {
    const data: unknown = JSON.parse(json);
    if (!data || typeof data !== "object" || Array.isArray(data)) return [];
    return Object.entries(data as Record<string, unknown>)
      .filter(([, v]) => v === true)
      .map(([k]) => labels[k] || k.replace(/([A-Z])/g, " $1").trim());
  } catch {
    return [];
  }
}
