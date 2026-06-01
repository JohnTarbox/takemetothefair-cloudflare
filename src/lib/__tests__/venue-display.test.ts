import { describe, it, expect } from "vitest";
import { displayVenueName, looksLikeStreetAddress } from "../venue-display";

describe("looksLikeStreetAddress", () => {
  it("matches names that begin with a street number", () => {
    expect(looksLikeStreetAddress("18 Spring Street")).toBe(true);
    expect(looksLikeStreetAddress("256 High Street")).toBe(true);
    expect(looksLikeStreetAddress("100 Riverside Drive")).toBe(true);
    expect(looksLikeStreetAddress(" 42  Elm  St")).toBe(true);
  });

  it("does NOT match legitimate venue names", () => {
    expect(looksLikeStreetAddress("Maine State Fairgrounds")).toBe(false);
    expect(looksLikeStreetAddress("Cumberland County Civic Center")).toBe(false);
    expect(looksLikeStreetAddress("Building 5")).toBe(false); // letters before digits
    expect(looksLikeStreetAddress("10X Studios")).toBe(false); // no whitespace after digits
    expect(looksLikeStreetAddress("21st Century Concert Hall")).toBe(false); // no whitespace after digits
  });

  it("handles empty/null gracefully", () => {
    expect(looksLikeStreetAddress("")).toBe(false);
    // @ts-expect-error - testing runtime null handling
    expect(looksLikeStreetAddress(null)).toBe(false);
  });
});

describe("displayVenueName", () => {
  it("returns the raw name for legitimate venues", () => {
    expect(
      displayVenueName({
        name: "Maine State Fairgrounds",
        city: "Bangor",
        state: "ME",
      })
    ).toBe("Maine State Fairgrounds");
  });

  it("falls back to City, State for street-address names", () => {
    expect(
      displayVenueName({
        name: "18 Spring Street",
        city: "Portland",
        state: "ME",
      })
    ).toBe("Event venue in Portland, ME");
  });

  it("falls back when name and address are bit-identical", () => {
    expect(
      displayVenueName({
        name: "Centre Street",
        address: "Centre Street",
        city: "Bath",
        state: "ME",
      })
    ).toBe("Event venue in Bath, ME");
  });

  it("falls back with just city when state is missing", () => {
    expect(
      displayVenueName({
        name: "100 Main St",
        city: "Portland",
        state: null,
      })
    ).toBe("Event venue in Portland");
  });

  it("falls back to bare 'Event venue' when city + state are both missing", () => {
    expect(displayVenueName({ name: "100 Main St" })).toBe("Event venue");
  });

  it("handles empty/whitespace name", () => {
    expect(displayVenueName({ name: "  ", city: "Augusta", state: "ME" })).toBe(
      "Event venue in Augusta, ME"
    );
  });
});
