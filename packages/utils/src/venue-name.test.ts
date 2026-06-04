import { describe, it, expect } from "vitest";
import {
  coerceVenueNameAtIngest,
  looksLikeVenueStreetAddress,
  venueLocationFallback,
} from "./venue-name";

describe("looksLikeVenueStreetAddress", () => {
  it("matches digit-run + whitespace prefix", () => {
    expect(looksLikeVenueStreetAddress("18 Spring Street")).toBe(true);
    expect(looksLikeVenueStreetAddress("256 High Street")).toBe(true);
    expect(looksLikeVenueStreetAddress("100 Riverside Drive")).toBe(true);
    expect(looksLikeVenueStreetAddress("76 US Route 1")).toBe(true);
  });

  it("does NOT match digit-only or no-whitespace inputs (conservative)", () => {
    expect(looksLikeVenueStreetAddress("123")).toBe(false);
    expect(looksLikeVenueStreetAddress("10X Studios")).toBe(false);
    expect(looksLikeVenueStreetAddress("Building 5")).toBe(false);
    expect(looksLikeVenueStreetAddress("5 Star Hall")).toBe(true);
    // ^ this is a known false positive — covered in the helper's comment.
  });

  it("handles empty / whitespace", () => {
    expect(looksLikeVenueStreetAddress("")).toBe(false);
    expect(looksLikeVenueStreetAddress("   ")).toBe(false);
  });
});

describe("venueLocationFallback", () => {
  it("renders 'Event venue in <City>, <State>' when both present", () => {
    expect(venueLocationFallback({ city: "Belfast", state: "ME" })).toBe(
      "Event venue in Belfast, ME"
    );
  });

  it("falls back gracefully when city or state is missing", () => {
    expect(venueLocationFallback({ city: "Belfast", state: null })).toBe("Event venue in Belfast");
    expect(venueLocationFallback({ city: null, state: "ME" })).toBe("Event venue in ME");
    expect(venueLocationFallback({ city: null, state: null })).toBe("Event venue");
  });
});

describe("coerceVenueNameAtIngest", () => {
  it("passes through clean venue names unchanged", () => {
    const out = coerceVenueNameAtIngest({
      name: "Waterfall Arts",
      address: "256 High Street",
      city: "Belfast",
      state: "ME",
    });
    expect(out.wasCoerced).toBe(false);
    expect(out.name).toBe("Waterfall Arts");
    expect(out.address).toBe("256 High Street");
  });

  it("coerces street-number-in-name to fallback + preserves address", () => {
    const out = coerceVenueNameAtIngest({
      name: "18 Spring Street",
      address: "18 Spring Street",
      city: "Belfast",
      state: "ME",
    });
    expect(out.wasCoerced).toBe(true);
    expect(out.name).toBe("Event venue in Belfast, ME");
    // Original address preserved — we don't overwrite a real address even
    // when it equals the offending name.
    expect(out.address).toBe("18 Spring Street");
    expect(out.reason).toBe("name-equals-address");
  });

  it("street-address name with empty address: copies name → address", () => {
    const out = coerceVenueNameAtIngest({
      name: "256 High Street",
      address: "",
      city: "Burlington",
      state: "VT",
    });
    expect(out.wasCoerced).toBe(true);
    expect(out.name).toBe("Event venue in Burlington, VT");
    expect(out.address).toBe("256 High Street");
    expect(out.reason).toBe("street-number-in-name");
  });

  it("street-address name with null address: copies name → address", () => {
    const out = coerceVenueNameAtIngest({
      name: "76 US Route 1",
      address: null,
      city: "Machias",
      state: "ME",
    });
    expect(out.wasCoerced).toBe(true);
    expect(out.name).toBe("Event venue in Machias, ME");
    expect(out.address).toBe("76 US Route 1");
  });

  it("name-equals-address with real address (not street-prefixed): coerces", () => {
    // E.g. a building name dumped into both fields.
    const out = coerceVenueNameAtIngest({
      name: "Belfast Community Hall",
      address: "Belfast Community Hall",
      city: "Belfast",
      state: "ME",
    });
    expect(out.wasCoerced).toBe(true);
    expect(out.name).toBe("Event venue in Belfast, ME");
    expect(out.reason).toBe("name-equals-address");
  });

  it("trims whitespace before comparing name to address", () => {
    const out = coerceVenueNameAtIngest({
      name: "  256 High Street  ",
      address: "256 High Street",
      city: "Belfast",
      state: "ME",
    });
    expect(out.wasCoerced).toBe(true);
  });
});
