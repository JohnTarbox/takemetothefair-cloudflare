/**
 * OPE-207 — pure decision logic for `venues_geocode`.
 *
 * Given a venue row and (optionally) what Google returned, decide the outcome.
 * No I/O, so the whole "should we write this pin?" judgment is unit-testable.
 *
 * WHY THIS IS STRICTER THAN THE ADMIN FORM: the existing
 * /api/admin/venues/geocode-batch route writes Google's top hit unconditionally,
 * which is acceptable when a human is looking at a map. This tool feeds
 * OPE-203, which attributes on-site photos to a fair by finding venues within
 * 1.5 miles of the photo's GPS. A city-centroid pin there doesn't degrade
 * gracefully — it silently matches the wrong venue, or none. So: better a
 * flagged blank than a wrong pin (the ticket's own words).
 */
import type { GeocodeDetail } from "../google-maps";

export type GeocodeStatus =
  | "ok"
  | "already-geocoded"
  | "insufficient-address"
  | "no-match"
  | "low-confidence"
  | "error";

export interface VenueForGeocode {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface GeocodeOutcome {
  venue_id: string;
  name: string;
  before: { lat: number | null; lng: number | null };
  after: { lat: number | null; lng: number | null; place_id: string | null };
  status: GeocodeStatus;
  error?: string;
  /** Google's formatted address for the top hit — lets the caller eyeball a
   *  low-confidence match and decide whether to re-run with force. */
  candidate?: string;
}

/**
 * Location types we refuse to store.
 *
 * APPROXIMATE is a city/region centroid — for "Fryeburg Fairgrounds, Fryeburg,
 * ME" a failed match degrades to "the middle of Fryeburg", which is a
 * confident-looking pin that is simply wrong. Everything else
 * (ROOFTOP / RANGE_INTERPOLATED / GEOMETRIC_CENTER) is address-level.
 */
const REJECTED_LOCATION_TYPES = new Set(["APPROXIMATE"]);

/** Enough of an address to bother asking Google. */
export function hasSufficientAddress(v: VenueForGeocode): boolean {
  // Mirrors the existing /api/admin/venues/geocode contract (address + city +
  // state required). Zip alone can't disambiguate a venue name.
  return Boolean(v.address?.trim() && v.city?.trim() && v.state?.trim());
}

export function isAlreadyGeocoded(v: VenueForGeocode): boolean {
  return v.latitude !== null && v.longitude !== null;
}

/**
 * Decide the outcome for a venue we have NOT yet called Google for.
 * Returns null when the caller should go ahead and geocode.
 */
export function preflight(v: VenueForGeocode, force: boolean): GeocodeOutcome | null {
  const before = { lat: v.latitude, lng: v.longitude };
  if (isAlreadyGeocoded(v) && !force) {
    return {
      venue_id: v.id,
      name: v.name,
      before,
      after: { lat: v.latitude, lng: v.longitude, place_id: null },
      status: "already-geocoded",
    };
  }
  if (!hasSufficientAddress(v)) {
    return {
      venue_id: v.id,
      name: v.name,
      before,
      after: { lat: null, lng: null, place_id: null },
      status: "insufficient-address",
    };
  }
  return null;
}

/**
 * Judge Google's answer. Pure: the caller does the fetch and the write.
 *
 * A `low-confidence` result is reported with its candidate name and NOT
 * written — the operator can re-run with `force: true` if the candidate looks
 * right.
 */
export function judge(v: VenueForGeocode, detail: GeocodeDetail | null): GeocodeOutcome {
  const before = { lat: v.latitude, lng: v.longitude };
  const blank = { lat: null, lng: null, place_id: null };

  if (!detail) {
    return { venue_id: v.id, name: v.name, before, after: blank, status: "no-match" };
  }

  const reasons: string[] = [];
  if (detail.candidateCount > 1) reasons.push(`${detail.candidateCount} candidates`);
  if (detail.partialMatch) reasons.push("partial match");
  if (detail.locationType && REJECTED_LOCATION_TYPES.has(detail.locationType)) {
    reasons.push(`location_type=${detail.locationType}`);
  }

  if (reasons.length > 0) {
    return {
      venue_id: v.id,
      name: v.name,
      before,
      after: blank,
      status: "low-confidence",
      error: reasons.join(", "),
      candidate: detail.formattedAddress ?? undefined,
    };
  }

  return {
    venue_id: v.id,
    name: v.name,
    before,
    after: { lat: detail.lat, lng: detail.lng, place_id: detail.placeId },
    status: "ok",
    candidate: detail.formattedAddress ?? undefined,
  };
}
