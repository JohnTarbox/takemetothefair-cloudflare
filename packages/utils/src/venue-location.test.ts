import { describe, it, expect } from "vitest";
import { venueLocationCompatible } from "./venue-location";

describe("venueLocationCompatible (OPE-1146)", () => {
  it.each([
    [{ city: "Norwalk", state: "CT" }, { city: "Old Orchard Beach", state: "ME" }, false],
    [{ city: "Norwalk", state: "CT" }, { city: null, state: "ME" }, false],
    [{ city: "Portland", state: "ME" }, { city: "Bangor", state: "ME" }, false],
    [{ city: "Portland", state: "ME" }, { city: "portland ", state: "me" }, true],
    [{ city: "", state: "ME" }, { city: "Bangor", state: "ME" }, true],
    [{ city: "Bangor", state: "" }, { city: "Bangor", state: "ME" }, true],
    [{ city: "Norwalk", state: "CT" }, { city: null, state: null }, true],
  ])("%j vs %j → %s", (candidate, input, want) => {
    expect(venueLocationCompatible(candidate, input)).toBe(want);
  });
});
