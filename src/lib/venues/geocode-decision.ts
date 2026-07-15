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
  /** Low-confidence, but stored anyway because the caller passed `force`. */
  | "forced"
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
 * `judge` always reports what Google actually returned, regardless of `force` —
 * it takes no `force` parameter on purpose. Overriding is a decision about
 * whether to STORE the pin, not about what the pin is, so it lives in
 * `shouldWrite` / `forcedOutcome`. Keeping the two apart is what lets a forced
 * write still carry the reason the gate objected.
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

/**
 * OPE-215 — should the caller store this outcome's pin?
 *
 * `force` overrides the CONFIDENCE verdict and nothing else. It cannot conjure
 * a pin that doesn't exist: `no-match` has no candidate to store, and
 * `insufficient-address` never asked Google in the first place. Letting force
 * reach those would turn "I looked at the candidate and it's right" into
 * "write something, anything" — the exact failure the gate exists to prevent.
 */
export function shouldWrite(outcome: GeocodeOutcome, force: boolean): boolean {
  if (outcome.status === "ok") return true;
  return force && outcome.status === "low-confidence";
}

/**
 * Re-label a low-confidence outcome the operator chose to store.
 *
 * `error` and `candidate` are deliberately KEPT, and the status is `forced`
 * rather than `ok`: a pin that beat the gate by override must never be
 * indistinguishable from one the gate cleared on its own. OPE-203 attributes
 * on-site photos to a fair using these coordinates, so "which pins did someone
 * override, and what did the gate object to?" has to stay answerable — in this
 * record, and in `admin_actions` after the response is gone.
 */
export function forcedOutcome(outcome: GeocodeOutcome, detail: GeocodeDetail): GeocodeOutcome {
  return {
    ...outcome,
    status: "forced",
    after: { lat: detail.lat, lng: detail.lng, place_id: detail.placeId },
  };
}
