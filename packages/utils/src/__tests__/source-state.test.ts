import { describe, expect, it } from "vitest";
import { isNewEnglandState, sourceOutsideNewEngland, venueStateConflict } from "../source-state";

describe("source-state (OPE-1206)", () => {
  it("a known state on both sides that differs is a conflict", () => {
    expect(venueStateConflict("OR", "ME")).toEqual({ sourceState: "OR", venueState: "ME" });
    expect(venueStateConflict(" or ", "me")).toEqual({ sourceState: "OR", venueState: "ME" });
  });
  it("agreement, or a missing / unparseable side, is not a conflict", () => {
    expect(venueStateConflict("ME", "ME")).toBeNull();
    expect(venueStateConflict(null, "ME")).toBeNull();
    expect(venueStateConflict("Oregon", "ME")).toBeNull();
    expect(venueStateConflict("OR", "")).toBeNull();
  });
  it("New England membership", () => {
    for (const s of ["CT", "MA", "ME", "NH", "RI", "VT"]) expect(isNewEnglandState(s)).toBe(true);
    expect(isNewEnglandState("NY")).toBe(false);
    expect(sourceOutsideNewEngland("OR")).toBe(true);
    expect(sourceOutsideNewEngland("ME")).toBe(false);
    expect(sourceOutsideNewEngland(null)).toBe(false);
  });
});
