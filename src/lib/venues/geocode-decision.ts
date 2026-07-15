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
 *
 * TWO PATHS (OPE-213): a venue with a street address goes to the Geocoding API
 * (`judge`); a venue with only name + city + state goes to a Places TEXT SEARCH
 * (`judgeNameLookup`). They need different gates because the two APIs return
 * different evidence — see `judgeNameLookup` for why `judge`'s signals can't be
 * reused.
 */
import { normalizeName, tokenize } from "@takemetothefair/utils";
import type { GeocodeDetail, PlaceLookupResult } from "../google-maps";

export type GeocodeStatus =
  | "ok"
  /** Low-confidence, but stored anyway because the caller passed `force`. */
  | "forced"
  | "already-geocoded"
  | "insufficient-address"
  /**
   * The venue's own name says it has no single fixed location (OPE-219), so no
   * pin is correct and none is asked for. Distinct from `insufficient-address`
   * (data missing) and `low-confidence` (a candidate worth reviewing) — there
   * is nothing to research and nothing to force.
   */
  | "not-a-point"
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
  /**
   * How the pin was obtained (OPE-213). "name" means it came from a Places text
   * search on name+city+state rather than a street address, which is weaker
   * evidence — a name-derived pin should stay re-reviewable.
   */
  method?: "address" | "name";
}

/**
 * The minimum a caller needs to store a pin, from either path. Narrower than
 * both `GeocodeDetail` and `PlaceLookupResult` on purpose, so the write site
 * doesn't care which API answered.
 */
export interface GeocodePin {
  lat: number;
  lng: number;
  placeId: string | null;
  /** Fills a blank zip; never overwrites a stored one. */
  zip: string | null;
  /** Only the name path can supply this — it's what OPE-213 back-fills. */
  address: string | null;
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

/** Enough of an address to bother asking the Geocoding API. */
export function hasSufficientAddress(v: VenueForGeocode): boolean {
  // Mirrors the existing /api/admin/venues/geocode contract (address + city +
  // state required). Zip alone can't disambiguate a venue name.
  return Boolean(v.address?.trim() && v.city?.trim() && v.state?.trim());
}

/**
 * Enough to attempt a Places text search instead (OPE-213).
 *
 * The 38 addressless venues blocking OPE-203's photo lane are landmarks —
 * Tanglewood, MASS MoCA, Jacob's Pillow — that all have a name and a city+state.
 * They don't need address research; they need to be looked up by name. Without
 * this they return `insufficient-address` forever.
 */
export function hasNameLookupInputs(v: VenueForGeocode): boolean {
  return Boolean(v.name?.trim() && v.city?.trim() && v.state?.trim());
}

/**
 * Does the venue's own name declare it has no single fixed location? (OPE-219)
 *
 * "Framingham Parks (Rotating)", "Various Studios (Somerville)" — these rows say
 * outright that the event moves. No pin is correct for them, so grading Google's
 * answer is the wrong question: the signal was never in Google's reply, it was
 * in our name all along. On the OPE-213 run both of these matched an office and
 * stored a wrong pin, because every other signal (right city, right state,
 * plausible name) agreed.
 *
 * Kept deliberately narrow. `multiple` alone would reject a real "Multiple
 * Sclerosis Society Hall", so it only counts in the phrase "multiple
 * locations/venues/sites".
 */
const NON_POINT_NAME =
  /\b(?:rotating|various|varies|tbd)\b|\bmultiple\s+(?:locations?|venues?|sites?)\b/i;

export function isNonPointVenue(v: VenueForGeocode): boolean {
  return NON_POINT_NAME.test(v.name ?? "");
}

/**
 * Google's candidate is a business in an office suite (OPE-219).
 *
 * For a park / green / downtown / course venue, a suite number is strong
 * evidence the text search matched the ORGANIZATION that runs the place rather
 * than the place: "Falmouth Road Race Course" → `205 Worcester Ct Ste B-4`
 * (the race office), "Downtown Wallingford" → `220 N Colony Rd Ste D` (an
 * association office). Objective, and it catches the two cases name-matching
 * provably cannot — an office named after the event it runs scores 1.0 on any
 * name metric.
 *
 * Reported as low-confidence rather than refused outright: a small venue really
 * can live in a suite, so this stays reviewable and forceable.
 */
const OFFICE_SUITE = /\b(?:ste|suite|unit)\b/i;

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
  // OPE-219 — refuse to GUESS a pin for a venue that says it has none. Scoped
  // to the name path on purpose: an operator who typed a street address made a
  // deliberate choice and we respect it; this only blocks inventing a location
  // for a row whose name declares the event moves.
  if (!hasSufficientAddress(v) && isNonPointVenue(v)) {
    return {
      venue_id: v.id,
      name: v.name,
      before,
      after: { lat: null, lng: null, place_id: null },
      status: "not-a-point",
      error: "venue name declares no fixed location — no pin is correct",
    };
  }
  // Only give up when NEITHER path is viable. A venue with no street address
  // but a name + city + state is the name path's whole reason for existing.
  if (!hasSufficientAddress(v) && !hasNameLookupInputs(v)) {
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
  const base = { venue_id: v.id, name: v.name, before, method: "address" as const };

  if (!detail) {
    return { ...base, after: blank, status: "no-match" };
  }

  const reasons: string[] = [];
  if (detail.candidateCount > 1) reasons.push(`${detail.candidateCount} candidates`);
  if (detail.partialMatch) reasons.push("partial match");
  if (detail.locationType && REJECTED_LOCATION_TYPES.has(detail.locationType)) {
    reasons.push(`location_type=${detail.locationType}`);
  }

  if (reasons.length > 0) {
    return {
      ...base,
      after: blank,
      status: "low-confidence",
      error: reasons.join(", "),
      candidate: detail.formattedAddress ?? undefined,
    };
  }

  return {
    ...base,
    after: { lat: detail.lat, lng: detail.lng, place_id: detail.placeId },
    status: "ok",
    candidate: detail.formattedAddress ?? undefined,
  };
}

/** Same place-name, ignoring case and punctuation. Empty never corroborates. */
function sameText(a: string | null, b: string | null): boolean {
  const na = normalizeName(a ?? "");
  const nb = normalizeName(b ?? "");
  return na.length > 0 && na === nb;
}

/**
 * Token containment: what share of the SHORTER name's words appear in the other.
 *
 * Deliberately not Jaccard (intersection/union), which punishes Google for
 * being more specific than we are: "Jacob's Pillow" vs "Jacob's Pillow Dance
 * Festival" is 0.5 by Jaccard but 1.0 here, and it is obviously the same place.
 * Google's displayName is routinely a superset of our stored name, so
 * containment is the metric that matches reality.
 *
 * `ignore` (the city) is stripped from BOTH sides first, and this is load-
 * bearing rather than tidying. The city is already in the search query, so
 * Google echoing it back is not evidence. Without it, "Framingham Parks
 * (Rotating)" in Framingham vs a hit displayed as plain "Framingham" scores
 * 1/1 = 1.0 and sails through — storing a city centroid as a venue pin, the
 * exact wrong-pin failure this gate exists to stop. Stripping the city leaves
 * nothing to corroborate, which scores 0 and is the honest answer.
 */
export function nameOverlap(a: string, b: string, ignore?: string): number {
  const ignored = ignore ? tokenize(ignore) : new Set<string>();
  const keep = (s: string) => new Set(Array.from(tokenize(s)).filter((t) => !ignored.has(t)));
  const ta = keep(a);
  const tb = keep(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  const shared = Array.from(ta).filter((t) => tb.has(t)).length;
  return shared / Math.min(ta.size, tb.size);
}

/**
 * Below this, Google's answer isn't plausibly the venue we asked for.
 *
 * DO NOT raise this to catch the org-office case (OPE-219 §2, considered and
 * rejected): "Framingham Parks (Rotating)" vs "Framingham Parks & Recreation"
 * scores exactly 0.50 (one shared token, min-set 2) — but so does the CORRECT
 * "Memorial Boulevard, Bristol" vs Google's "Memorial Blvd", because
 * `boulevard` and `blvd` are different tokens. A plain abbreviation lands on
 * the identical score as the failure, so no threshold separates them. The
 * org-office case is caught by `isNonPointVenue` + `OFFICE_SUITE` instead,
 * which key on evidence the score can't see.
 */
const NAME_OVERLAP_MIN = 0.5;

/**
 * OPE-213 — judge a Places TEXT SEARCH answer for an addressless venue.
 *
 * WHY NOT REUSE `judge`: `lookupPlace` hits a different API and returns
 * different evidence. There is no `partial_match`, no `location_type`, and
 * `lookupPlace` discards the result count — so every signal `judge` gates on is
 * simply absent. Reusing it would mean gating on `undefined` and calling
 * everything clean, which is worse than no gate at all.
 *
 * What we gate on instead, in strength order:
 *  1. STATE must match. Cheap and near-airtight: a text search that lands in
 *     another state is a miss, and unlike city there's no aliasing to confuse it.
 *  2. CITY must match. Bounds the error to the right municipality, which is what
 *     keeps OPE-203's 1.5-mile radius honest.
 *  3. NAME must plausibly overlap Google's displayName — guards the "right town,
 *     wrong place" case (searching an unknown venue name and getting the town
 *     hall back).
 *
 * A mismatch is REPORTED, never stored: the operator sees the reason and the
 * candidate, and can accept it with `force` (OPE-215). That matters because
 * rule 2 has a known false-reject: Google's `city` is the postal `locality`,
 * which in New England is often the village rather than the town (Sterling→
 * Moosup, West Windsor→Brownsville, Winchester Center→Winsted are all real and
 * all correct). Those surface as reviewable low-confidence rather than silent
 * wrong pins — the conservative direction.
 */
export function judgeNameLookup(
  v: VenueForGeocode,
  place: PlaceLookupResult | null
): GeocodeOutcome {
  const before = { lat: v.latitude, lng: v.longitude };
  const blank = { lat: null, lng: null, place_id: null };
  const base = { venue_id: v.id, name: v.name, before, method: "name" as const };

  // No hit, or a hit with no coordinates, is nothing to store either way.
  if (!place || place.lat == null || place.lng == null) {
    return { ...base, after: blank, status: "no-match" };
  }

  const candidate = place.formattedAddress ?? place.name ?? undefined;
  const reasons: string[] = [];

  if (!sameText(place.state, v.state)) {
    reasons.push(`state mismatch (got ${place.state ?? "none"})`);
  } else if (!sameText(place.city, v.city)) {
    // Only worth saying once — a wrong state makes the city moot.
    reasons.push(`city mismatch (got ${place.city ?? "none"})`);
  }

  // The city is stripped from both names — it's in the query, so Google
  // repeating it corroborates nothing.
  if (place.name && nameOverlap(v.name, place.name, v.city ?? "") < NAME_OVERLAP_MIN) {
    reasons.push(`name mismatch (got "${place.name}")`);
  }

  // OPE-219 — a suite number means Google matched a business. For the venues on
  // this path (parks, greens, downtowns) that's the org's office, not the place.
  if (place.formattedAddress && OFFICE_SUITE.test(place.formattedAddress)) {
    reasons.push("candidate is an office suite — likely the organization, not the venue");
  }

  if (reasons.length > 0) {
    return {
      ...base,
      after: blank,
      status: "low-confidence",
      error: reasons.join(", "),
      candidate,
    };
  }

  return {
    ...base,
    after: { lat: place.lat, lng: place.lng, place_id: place.googlePlaceId },
    status: "ok",
    candidate,
  };
}

/**
 * OPE-214 — the cursor for the next `missing_only` page, or null when drained.
 *
 * KEYSET, not offset, and that choice is the whole fix. The candidate set
 * MUTATES as we work: a venue we successfully pin stops matching
 * `latitude IS NULL` and leaves. Under `LIMIT/OFFSET` that shifts every later
 * row left, so `OFFSET 25` after a page that wrote 20 rows silently SKIPS 20
 * venues — the drain "finishes" having never looked at them. A keyset cursor
 * (`WHERE id > :cursor ORDER BY id`) can't be shifted by a row leaving the set.
 *
 * It also fixes the original stall for free: an outcome that doesn't write
 * (`insufficient-address`, `not-a-point`, `low-confidence`, `no-match`) keeps
 * `latitude IS NULL` and would match the filter forever, but its id is now
 * BEHIND the cursor, so it is never handed out twice.
 *
 * A full page means "there may be more"; a short page means drained. Returning
 * a cursor on a short page would just cost the caller one empty round-trip.
 */
export function nextCursor(rows: Array<{ id: string }>, limit: number): string | null {
  return rows.length === limit && rows.length > 0 ? rows[rows.length - 1].id : null;
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
export function forcedOutcome(
  outcome: GeocodeOutcome,
  pin: Pick<GeocodePin, "lat" | "lng" | "placeId">
): GeocodeOutcome {
  return {
    ...outcome,
    status: "forced",
    after: { lat: pin.lat, lng: pin.lng, place_id: pin.placeId },
  };
}
