import { describe, it, expect } from "vitest";
import {
  preflight,
  judge,
  judgeNameLookup,
  nameOverlap,
  nextCursor,
  shouldWrite,
  forcedOutcome,
  hasSufficientAddress,
  hasNameLookupInputs,
  isNonPointVenue,
  isAlreadyGeocoded,
  type GeocodeOutcome,
  type VenueForGeocode,
} from "../geocode-decision";
import type { GeocodeDetail, PlaceLookupResult } from "../../google-maps";

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

describe("hasSufficientAddress / hasNameLookupInputs / isAlreadyGeocoded", () => {
  it("requires address + city + state", () => {
    expect(hasSufficientAddress(venue())).toBe(true);
    expect(hasSufficientAddress(venue({ address: "" }))).toBe(false);
    expect(hasSufficientAddress(venue({ address: null }))).toBe(false);
    expect(hasSufficientAddress(venue({ city: "   " }))).toBe(false);
    expect(hasSufficientAddress(venue({ state: null }))).toBe(false);
    // Zip alone can't disambiguate a venue.
    expect(hasSufficientAddress(venue({ zip: null }))).toBe(true);
  });

  it("name lookup needs name + city + state, but no address (OPE-213)", () => {
    expect(hasNameLookupInputs(venue({ address: "" }))).toBe(true);
    expect(hasNameLookupInputs(venue({ address: null, zip: null }))).toBe(true);
    expect(hasNameLookupInputs(venue({ city: "" }))).toBe(false);
    expect(hasNameLookupInputs(venue({ state: "  " }))).toBe(false);
    expect(hasNameLookupInputs(venue({ name: "" }))).toBe(false);
  });

  it("isNonPointVenue reads OUR name, not Google's answer (OPE-219)", () => {
    expect(isNonPointVenue(venue({ name: "Framingham Parks (Rotating)" }))).toBe(true);
    expect(isNonPointVenue(venue({ name: "Various Studios (Somerville)" }))).toBe(true);
    expect(isNonPointVenue(venue({ name: "Location TBD" }))).toBe(true);
    expect(isNonPointVenue(venue({ name: "Multiple Locations" }))).toBe(true);
    // Ordinary venues are untouched.
    expect(isNonPointVenue(venue({ name: "Fryeburg Fairgrounds" }))).toBe(false);
    expect(isNonPointVenue(venue({ name: "Tanglewood" }))).toBe(false);
    // Kept narrow on purpose: bare "multiple" must not reject a real venue.
    expect(isNonPointVenue(venue({ name: "Multiple Sclerosis Society Hall" }))).toBe(false);
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

  it("reports insufficient-address only when NEITHER path is viable", () => {
    // No address AND no city to search by name with — nothing to ask Google.
    expect(preflight(venue({ address: "", city: "" }), false)?.status).toBe("insufficient-address");
    expect(preflight(venue({ address: "", state: null }), false)?.status).toBe(
      "insufficient-address"
    );
  });

  it("lets an addressless venue through to the name path (OPE-213)", () => {
    // Tanglewood-shaped: no street address, but name + city + state. This used
    // to dead-end at insufficient-address forever.
    expect(preflight(venue({ address: "" }), false)).toBeNull();
    expect(preflight(venue({ address: null }), false)).toBeNull();
  });

  // OPE-219 — refuse to invent a pin for a venue that says it has none.
  it("returns not-a-point for a rotating venue, with NO Google call", () => {
    const out = preflight(
      venue({ name: "Framingham Parks (Rotating)", address: "", city: "Framingham", state: "MA" }),
      false
    );
    expect(out?.status).toBe("not-a-point");
    expect(out?.after).toEqual({ lat: null, lng: null, place_id: null });
    // preflight short-circuiting IS the "no Google call" guarantee.
    expect(out).not.toBeNull();
  });

  it("returns not-a-point for a 'Various' venue", () => {
    expect(
      preflight(
        venue({
          name: "Various Studios (Somerville)",
          address: "",
          city: "Somerville",
          state: "MA",
        }),
        false
      )?.status
    ).toBe("not-a-point");
  });

  it("respects an operator-typed address on a rotating venue", () => {
    // We only refuse to GUESS. A real street address is a deliberate human
    // choice — geocode it via the address path as normal.
    expect(
      preflight(
        venue({
          name: "Framingham Parks (Rotating)",
          address: "475 Union Ave",
          city: "Framingham",
        }),
        false
      )
    ).toBeNull();
  });

  it("not-a-point is never forceable — no pin is correct", () => {
    const out = mustPreflight(
      venue({ name: "Framingham Parks (Rotating)", address: "", city: "Framingham", state: "MA" })
    );
    expect(shouldWrite(out, false)).toBe(false);
    expect(shouldWrite(out, true)).toBe(false);
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

// OPE-215 — `force` reached preflight() only, so a reviewed low-confidence
// candidate could never be stored by any argument, in contradiction of the
// tool's own docs. These pin the write decision that was missing.
const mustPreflight = (v: VenueForGeocode, force = false): GeocodeOutcome => {
  const out = preflight(v, force);
  if (!out) throw new Error("expected preflight to short-circuit");
  return out;
};

describe("shouldWrite", () => {
  const ok = judge(venue(), detail());
  const low = judge(venue(), detail({ partialMatch: true }));
  const noMatch = judge(venue(), null);

  it("writes a clean match, force or not", () => {
    expect(shouldWrite(ok, false)).toBe(true);
    expect(shouldWrite(ok, true)).toBe(true);
  });

  it("holds a low-confidence match by default — the core safety property", () => {
    expect(shouldWrite(low, false)).toBe(false);
  });

  it("writes a low-confidence match under force — the escape hatch itself", () => {
    expect(shouldWrite(low, true)).toBe(true);
  });

  it("force never invents a pin where Google gave no candidate", () => {
    // force overrides the CONFIDENCE verdict, not the absence of an answer:
    // no-match has nothing to store, insufficient-address never asked Google.
    // (city:"" so NEITHER path is viable — address:"" alone now goes to the
    // name path, per OPE-213.)
    expect(shouldWrite(noMatch, true)).toBe(false);
    expect(shouldWrite(mustPreflight(venue({ address: "", city: "" })), true)).toBe(false);
  });

  it("never writes an already-geocoded skip", () => {
    const skip = mustPreflight(venue({ latitude: 44, longitude: -70 }));
    expect(shouldWrite(skip, false)).toBe(false);
    expect(shouldWrite(skip, true)).toBe(false);
  });
});

// OPE-213 — the name path. Cases are drawn from the real 38 addressless
// venues blocking OPE-203's photo lane.
const tanglewood = (over: Partial<VenueForGeocode> = {}): VenueForGeocode =>
  venue({ name: "Tanglewood", address: "", city: "Lenox", state: "MA", zip: "", ...over });

const place = (over: Partial<PlaceLookupResult> = {}): PlaceLookupResult =>
  ({
    name: "Tanglewood",
    lat: 42.3466,
    lng: -73.3115,
    address: "297 West St",
    city: "Lenox",
    state: "MA",
    zip: "01240",
    formattedAddress: "297 West St, Lenox, MA 01240, USA",
    googlePlaceId: "ChIJtanglewood",
    ...over,
  }) as PlaceLookupResult;

describe("nameOverlap", () => {
  it("scores an exact name 1", () => {
    expect(nameOverlap("Tanglewood", "Tanglewood")).toBe(1);
  });

  it("scores 1 when Google is merely more specific than we are", () => {
    // The common real shape — and precisely where Jaccard would say 0.5 and
    // wrongly reject. Containment is the metric that matches reality.
    expect(nameOverlap("Jacob's Pillow", "Jacob's Pillow Dance Festival")).toBe(1);
    expect(nameOverlap("MASS MoCA", "MASS MoCA Museum")).toBe(1);
  });

  it("scores 0 for unrelated names", () => {
    expect(nameOverlap("Ballard Park", "Ridgefield Town Hall")).toBe(0);
  });

  it("is case- and punctuation-insensitive", () => {
    expect(nameOverlap("JACOB'S PILLOW", "jacobs pillow")).toBe(1);
  });

  it("scores 0 against an empty name rather than dividing by zero", () => {
    expect(nameOverlap("Tanglewood", "")).toBe(0);
    expect(nameOverlap("", "Tanglewood")).toBe(0);
  });

  it("scores a plain abbreviation at exactly 0.5 — why the threshold can't rise", () => {
    // OPE-219 §2 (raise NAME_OVERLAP_MIN) was REJECTED because of this row.
    // The correct pin "Memorial Boulevard, Bristol" vs Google's "Memorial Blvd"
    // scores 0.50 — the SAME score as the org-office failure
    // ("Framingham Parks (Rotating)" vs "Framingham Parks & Recreation").
    // No threshold separates a correct abbreviation from a wrong office, so
    // raising the bar would reject real pins. If this ever stops being 0.5,
    // re-litigate that decision.
    expect(nameOverlap("Memorial Boulevard, Bristol", "Memorial Blvd", "Bristol")).toBe(0.5);
    expect(
      nameOverlap("Framingham Parks (Rotating)", "Framingham Parks & Recreation", "Framingham")
    ).toBe(0.5);
  });

  it("ignores the city — echoing the query back is not corroboration", () => {
    // Without stripping the city this is 1/1 = 1.0 and a city centroid gets
    // stored as a venue pin. With it, there is nothing left to corroborate.
    expect(nameOverlap("Framingham Parks (Rotating)", "Framingham", "Framingham")).toBe(0);
    // A real distinctive token still corroborates once the city is gone.
    expect(nameOverlap("Downtown Worcester (City Common)", "Worcester Common", "Worcester")).toBe(
      1
    );
  });
});

describe("judgeNameLookup", () => {
  it("accepts a name+city+state match and reports method 'name'", () => {
    const out = judgeNameLookup(tanglewood(), place());
    expect(out.status).toBe("ok");
    expect(out.method).toBe("name");
    expect(out.after).toEqual({ lat: 42.3466, lng: -73.3115, place_id: "ChIJtanglewood" });
  });

  it("reports no-match when the text search returns nothing", () => {
    expect(judgeNameLookup(tanglewood(), null).status).toBe("no-match");
  });

  it("reports no-match when a hit carries no coordinates", () => {
    // Nothing to store — a hit without a pin is not a pin.
    expect(judgeNameLookup(tanglewood(), place({ lat: null })).status).toBe("no-match");
    expect(judgeNameLookup(tanglewood(), place({ lng: null })).status).toBe("no-match");
  });

  // The safety property the ticket names: never store a pin whose city/state
  // disagrees with the row.
  it("refuses a hit in a different state — the Ballard Park case", () => {
    const out = judgeNameLookup(tanglewood(), place({ state: "NY", city: "Lenox" }));
    expect(out.status).toBe("low-confidence");
    expect(out.error).toContain("state mismatch");
    expect(out.after).toEqual({ lat: null, lng: null, place_id: null });
  });

  it("refuses a hit in a different city", () => {
    const out = judgeNameLookup(tanglewood(), place({ city: "Pittsfield" }));
    expect(out.status).toBe("low-confidence");
    expect(out.error).toContain("city mismatch");
    expect(out.after.lat).toBeNull();
  });

  it("blames the state, not the city, when both are wrong", () => {
    // A wrong state makes the city moot — one clear reason beats two.
    const out = judgeNameLookup(tanglewood(), place({ city: "Albany", state: "NY" }));
    expect(out.error).toContain("state mismatch");
    expect(out.error).not.toContain("city mismatch");
  });

  it("refuses the right town but the wrong place — the town-hall case", () => {
    const out = judgeNameLookup(
      venue({ name: "Ballard Park", address: "", city: "Ridgefield", state: "CT" }),
      place({ name: "Ridgefield Town Hall", city: "Ridgefield", state: "CT" })
    );
    expect(out.status).toBe("low-confidence");
    expect(out.error).toContain("name mismatch");
  });

  it("surfaces the candidate so a low-confidence answer can be reviewed and forced", () => {
    const out = judgeNameLookup(tanglewood(), place({ city: "Pittsfield" }));
    expect(out.candidate).toContain("297 West St");
    // The whole point of reporting rather than dropping: OPE-215's force can
    // act on it. Google's `city` is the postal locality, which in New England
    // is often the village not the town, so this path has real false-rejects.
    expect(shouldWrite(out, true)).toBe(true);
    expect(shouldWrite(out, false)).toBe(false);
  });

  it("accepts a village/town alias only via review, never silently", () => {
    // Winchester Center CT ↔ Google's "Winsted" is a REAL correct pin, but it
    // reads as a city mismatch. Conservative direction: report, don't store.
    const out = judgeNameLookup(
      venue({
        name: "Winchester Grange Hall",
        address: "",
        city: "Winchester Center",
        state: "CT",
      }),
      place({ name: "Winchester Grange Hall", city: "Winsted", state: "CT" })
    );
    expect(out.status).toBe("low-confidence");
    expect(out.error).toContain("city mismatch");
  });

  it("refuses a bare city-name hit for a rotating venue — the centroid trap", () => {
    // "Framingham Parks (Rotating)" has no single location. If Google answers
    // with the municipality itself, every other signal agrees (right city,
    // right state) and only the city-stripped name check catches it.
    const out = judgeNameLookup(
      venue({ name: "Framingham Parks (Rotating)", address: "", city: "Framingham", state: "MA" }),
      place({ name: "Framingham", city: "Framingham", state: "MA" })
    );
    expect(out.status).toBe("low-confidence");
    expect(out.error).toContain("name mismatch");
    expect(out.after).toEqual({ lat: null, lng: null, place_id: null });
  });

  // OPE-219 — the org-office case. Name matching provably cannot catch these:
  // an office named after the event it runs scores 1.0 on any name metric.
  it("refuses a candidate in an office suite — the org, not the venue", () => {
    const out = judgeNameLookup(
      venue({ name: "Falmouth Road Race Course", address: "", city: "Falmouth", state: "MA" }),
      place({
        name: "Falmouth Road Race",
        city: "Falmouth",
        state: "MA",
        formattedAddress: "205 Worcester Ct Ste B-4, Falmouth, MA 02540, USA",
      })
    );
    expect(out.status).toBe("low-confidence");
    expect(out.error).toContain("office suite");
    expect(out.after).toEqual({ lat: null, lng: null, place_id: null });
  });

  it("catches the office suite even when the name matches perfectly", () => {
    // "Falmouth Road Race Course" vs "Falmouth Road Race" scores 1.0 — the
    // office is named after the event it runs, so no name threshold can ever
    // reject it. Only the suite signal sees this one.
    expect(nameOverlap("Falmouth Road Race Course", "Falmouth Road Race", "Falmouth")).toBe(1);
  });

  it("leaves a suite-free candidate alone", () => {
    const out = judgeNameLookup(tanglewood(), place());
    expect(out.status).toBe("ok");
  });

  it("stays forceable — a small venue really can be in a suite", () => {
    const out = judgeNameLookup(
      venue({ name: "Downtown Wallingford", address: "", city: "Wallingford", state: "CT" }),
      place({
        name: "Downtown Wallingford",
        city: "Wallingford",
        state: "CT",
        formattedAddress: "220 N Colony Rd Ste D, Wallingford, CT 06492, USA",
      })
    );
    expect(shouldWrite(out, false)).toBe(false);
    expect(shouldWrite(out, true)).toBe(true);
  });

  it("tolerates a hit with no displayName rather than rejecting on it", () => {
    // Absent is not evidence of a bad match — same principle as a missing
    // location_type on the address path.
    expect(judgeNameLookup(tanglewood(), place({ name: null })).status).toBe("ok");
  });

  it("matches city/state case- and punctuation-insensitively", () => {
    const out = judgeNameLookup(tanglewood(), place({ city: "LENOX", state: "ma" }));
    expect(out.status).toBe("ok");
  });
});

// OPE-214 — missing_only handed back the same non-writing rows forever.
describe("nextCursor", () => {
  const page = (...ids: string[]) => ids.map((id) => ({ id }));

  it("returns the last id of a full page — there may be more", () => {
    expect(nextCursor(page("a", "b", "c"), 3)).toBe("c");
  });

  it("returns null on a short page — drained, so the loop terminates", () => {
    // This IS the termination guarantee: a caller looping until null stops.
    expect(nextCursor(page("a", "b"), 3)).toBeNull();
  });

  it("returns null on an empty page", () => {
    expect(nextCursor([], 25)).toBeNull();
  });

  it("advances past a page of entirely unfixable rows", () => {
    // The original stall: 25 insufficient-address rows keep latitude NULL and
    // re-match the filter every call. The cursor moves anyway, because it keys
    // on the last id EXAMINED, not on what happened to it.
    expect(nextCursor(page("v1", "v2", "v3"), 3)).toBe("v3");
  });
});

describe("forcedOutcome", () => {
  it("stores the candidate's coords", () => {
    const d = detail({ partialMatch: true });
    const out = forcedOutcome(judge(venue(), d), d);
    expect(out.after).toEqual({ lat: 44.0176, lng: -70.9803, place_id: "ChIJexample" });
  });

  it("stays distinguishable from a pin the gate cleared on its own", () => {
    const d = detail({ partialMatch: true, candidateCount: 2 });
    const out = forcedOutcome(judge(venue(), d), d);
    expect(out.status).toBe("forced");
    expect(out.status).not.toBe("ok");
    // The reason the gate objected must survive the override — OPE-203
    // attributes photos on this pin, so the doubt has to stay on the record.
    expect(out.error).toContain("partial match");
    expect(out.error).toContain("2 candidates");
    expect(out.candidate).toBe("1154 Main St, Fryeburg, ME 04037, USA");
  });
});
