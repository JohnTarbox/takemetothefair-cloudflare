/**
 * OPE-1201 item 3 — duplicate VENUE candidates the exact-name sweep cannot see.
 *
 * `/api/admin/duplicates/sweep-entities` clusters venues on
 * `(normalized name, city, state)`, so it only catches spelling variants of ONE
 * name. Snowport is two different names for one place — "Snowport at Boston
 * Seaport" (85 Northern Ave) and "Snowport at Seaport Common" (100 Seaport Blvd)
 * — and because the two event rows sat on different venue rows, no event-level
 * duplicate check could pair them either. A duplicate venue row hides every
 * duplicate EVENT that lands on it.
 *
 * Candidate rule, within one (city, state):
 *   - ≥2 shared identifying name tokens; or
 *   - both geocoded within 300 m AND ≥1 shared identifying token.
 * "Identifying" drops the city's own tokens and generic venue words (school,
 * center, hall, park, …) — without that, "Scarborough High School" pairs with
 * "Scarborough Middle School" on {scarborough, school}. Distance alone is not
 * enough: a town hall and the library next door are 50 m apart and different.
 *
 * Report-only. Nothing here merges; `merge_venue` is the human's call.
 */
import { normalizeName } from "@/lib/duplicates/normalize-name";
import { distinctiveTokens } from "@/lib/duplicates/name-containment";

export const VENUE_NEAR_METERS = 300;

const VENUE_GENERIC = new Set([
  "school",
  "high",
  "middle",
  "elementary",
  "academy",
  "center",
  "centre",
  "hall",
  "park",
  "church",
  "club",
  "community",
  "town",
  "city",
  "library",
  "grounds",
  "fairgrounds",
  "street",
  "main",
  "county",
  "state",
  "university",
  "college",
  "building",
  "room",
  "common",
  "commons",
  "green",
  "square",
  "house",
  "place",
  "field",
  "arena",
  "auditorium",
  "gym",
  "gymnasium",
  "lodge",
  "hotel",
  "inn",
  "resort",
  "farm",
  "farms",
  "museum",
  "public",
  "memorial",
  "united",
  "methodist",
  "congregational",
  "baptist",
  "catholic",
  "episcopal",
  "first",
  "saint",
  "north",
  "south",
  "east",
  "west",
  "new",
  // Region words locate a venue; they never identify one.
  "maine",
  "vermont",
  "hampshire",
  "massachusetts",
  "connecticut",
  "rhode",
  "island",
  "england",
]);

export interface VenueRowForNear {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface VenueNearPair {
  venue_ids: [string, string];
  names: [string, string];
  city: string;
  state: string;
  shared_tokens: string[];
  distance_m: number | null;
  reason: "name_tokens" | "geo_and_name";
}

function venueTokens(name: string, city: string | null): Set<string> {
  const cityTokens = new Set(city ? [...distinctiveTokens(normalizeName(city))] : []);
  return new Set(
    [...distinctiveTokens(normalizeName(name))].filter(
      (t) => !VENUE_GENERIC.has(t) && !cityTokens.has(t)
    )
  );
}

/** Great-circle distance in metres. */
export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function planVenueNearPairs(rows: readonly VenueRowForNear[]): VenueNearPair[] {
  const groups = new Map<string, VenueRowForNear[]>();
  for (const r of rows) {
    if (!r.city || !r.state) continue;
    const k = `${r.city.trim().toLowerCase()}|${r.state.trim().toUpperCase()}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }

  const out: VenueNearPair[] = [];
  for (const group of groups.values()) {
    const tokens = group.map((r) => venueTokens(r.name, r.city));
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = [group[i], group[j]];
        const shared = [...tokens[i]].filter((t) => tokens[j].has(t)).sort();
        if (shared.length === 0) continue;
        const distance =
          a.latitude != null && a.longitude != null && b.latitude != null && b.longitude != null
            ? Math.round(haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude))
            : null;
        let reason: VenueNearPair["reason"] | null = null;
        if (shared.length >= 2) reason = "name_tokens";
        else if (distance != null && distance <= VENUE_NEAR_METERS) reason = "geo_and_name";
        if (!reason) continue;
        out.push({
          venue_ids: [a.id, b.id],
          names: [a.name, b.name],
          city: a.city!,
          state: a.state!,
          shared_tokens: shared,
          distance_m: distance,
          reason,
        });
      }
    }
  }
  return out.sort(
    (x, y) =>
      y.shared_tokens.length - x.shared_tokens.length ||
      (x.distance_m ?? 1e9) - (y.distance_m ?? 1e9)
  );
}
