import { describe, it, expect } from "vitest";
import {
  preflight,
  judge,
  hasSufficientAddress,
  isAlreadyGeocoded,
  type VenueForGeocode,
} from "../geocode-decision";
import type { GeocodeDetail } from "../../google-maps";

const venue = (over: Partial<VenueForGeocode> = {}): VenueForGeocode => ({
  id: "v1",
  name: "Fryeburg Fairgrounds",
  address: "1154 Main St",
  city: "Fryeburg",
  state: "ME",
  zip: "04037",
  latitude: null,
  longitude: null,
  ...over,
});

const detail = (over: Partial<GeocodeDetail> = {}): GeocodeDetail => ({
  lat: 44.0176,
  lng: -70.9803,
  zip: "04037",
  placeId: "ChIJexample",
  formattedAddress: "1154 Main St, Fryeburg, ME 04037, USA",
  candidateCount: 1,
  partialMatch: false,
  locationType: "ROOFTOP",
  ...over,
});

describe("hasSufficientAddress / isAlreadyGeocoded", () => {
  it("requires address + city + state", () => {
    expect(hasSufficientAddress(venue())).toBe(true);
    expect(hasSufficientAddress(venue({ address: "" }))).toBe(false);
    expect(hasSufficientAddress(venue({ address: null }))).toBe(false);
    expect(hasSufficientAddress(venue({ city: "   " }))).toBe(false);
    expect(hasSufficientAddress(venue({ state: null }))).toBe(false);
    // Zip alone can't disambiguate a venue.
    expect(hasSufficientAddress(venue({ zip: null }))).toBe(true);
  });

  it("needs BOTH lat and lng to count as geocoded", () => {
    expect(isAlreadyGeocoded(venue())).toBe(false);
    expect(isAlreadyGeocoded(venue({ latitude: 44, longitude: -70 }))).toBe(true);
    // A half-populated row is not geocoded — it should be fixed, not skipped.
    expect(isAlreadyGeocoded(venue({ latitude: 44 }))).toBe(false);
  });
});

describe("preflight", () => {
  it("returns null (go ahead and geocode) for a fresh, addressable venue", () => {
    expect(preflight(venue(), false)).toBeNull();
  });

  it("skips an already-geocoded venue without calling Google", () => {
    const out = preflight(venue({ latitude: 44, longitude: -70 }), false);
    expect(out?.status).toBe("already-geocoded");
    // Non-destructive: the existing coords are echoed, not blanked.
    expect(out?.before).toEqual({ lat: 44, lng: -70 });
  });

  it("force lets an already-geocoded venue through to be re-geocoded", () => {
    expect(preflight(venue({ latitude: 44, longitude: -70 }), true)).toBeNull();
  });

  it("reports insufficient-address without calling Google", () => {
    expect(preflight(venue({ address: "" }), false)?.status).toBe("insufficient-address");
  });

  it("checks already-geocoded BEFORE address sufficiency", () => {
    // A geocoded venue with a junk address is fine as-is — don't nag about it.
    const out = preflight(venue({ address: "", latitude: 44, longitude: -70 }), false);
    expect(out?.status).toBe("already-geocoded");
  });
});

describe("judge", () => {
  it("accepts a clean single ROOFTOP match", () => {
    const out = judge(venue(), detail());
    expect(out.status).toBe("ok");
    expect(out.after).toEqual({ lat: 44.0176, lng: -70.9803, place_id: "ChIJexample" });
    expect(out.candidate).toContain("Fryeburg");
  });

  it("reports no-match when Google returns nothing", () => {
    expect(judge(venue(), null).status).toBe("no-match");
  });

  // The core safety property: these must NOT be written.
  it("rejects an APPROXIMATE (city-centroid) pin — the wrong-pin case", () => {
    const out = judge(venue(), detail({ locationType: "APPROXIMATE" }));
    expect(out.status).toBe("low-confidence");
    expect(out.error).toContain("APPROXIMATE");
    expect(out.after).toEqual({ lat: null, lng: null, place_id: null });
  });

  it("rejects an ambiguous multi-candidate answer", () => {
    const out = judge(venue(), detail({ candidateCount: 3 }));
    expect(out.status).toBe("low-confidence");
    expect(out.error).toContain("3 candidates");
  });

  it("rejects a partial match", () => {
    const out = judge(venue(), detail({ partialMatch: true }));
    expect(out.status).toBe("low-confidence");
    expect(out.error).toContain("partial match");
  });

  it("surfaces the candidate address on a low-confidence answer so force is an informed choice", () => {
    const out = judge(venue(), detail({ partialMatch: true }));
    expect(out.candidate).toBe("1154 Main St, Fryeburg, ME 04037, USA");
  });

  it("lists every reason when several fire at once", () => {
    const out = judge(
      venue(),
      detail({ candidateCount: 2, partialMatch: true, locationType: "APPROXIMATE" })
    );
    expect(out.error).toContain("2 candidates");
    expect(out.error).toContain("partial match");
    expect(out.error).toContain("APPROXIMATE");
  });

  it("accepts the address-level location types", () => {
    for (const t of ["ROOFTOP", "RANGE_INTERPOLATED", "GEOMETRIC_CENTER"]) {
      expect(judge(venue(), detail({ locationType: t })).status).toBe("ok");
    }
  });

  it("accepts a missing location_type rather than blocking on it", () => {
    // Absent is not evidence of a bad pin; only APPROXIMATE is.
    expect(judge(venue(), detail({ locationType: null })).status).toBe("ok");
  });

  it("echoes prior coords in `before` when force-regeocoding", () => {
    const out = judge(venue({ latitude: 1, longitude: 2 }), detail());
    expect(out.before).toEqual({ lat: 1, lng: 2 });
    expect(out.status).toBe("ok");
  });
});
