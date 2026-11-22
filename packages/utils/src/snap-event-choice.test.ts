import { describe, it, expect } from "vitest";
import {
  classifySnapTarget,
  parseSnapChoiceBasis,
  snapAmbiguityRadiusMiles,
  SNAP_AT_VENUE_RADIUS_MILES,
  SNAP_AMBIGUITY_MAX_MILES,
} from "./snap-event-choice";

const ev = (id: string, distanceMiles: number | null) => ({ id, distanceMiles });

describe("snapAmbiguityRadiusMiles", () => {
  it("never drops below the 1.5-mile at-venue radius", () => {
    expect(snapAmbiguityRadiusMiles(10)).toBe(SNAP_AT_VENUE_RADIUS_MILES);
    expect(snapAmbiguityRadiusMiles(null)).toBe(SNAP_AT_VENUE_RADIUS_MILES);
  });
  it("widens to 2× a poor fix, capped", () => {
    expect(snapAmbiguityRadiusMiles(2000)).toBeCloseTo((2 * 2000) / 1609.344, 5);
    expect(snapAmbiguityRadiusMiles(100_000)).toBe(SNAP_AMBIGUITY_MAX_MILES);
  });
});

describe("classifySnapTarget", () => {
  it("2026-11-21: two same-day fairs 0.21 mi apart → ambiguous, nearest first", () => {
    const t = classifySnapTarget([ev("church", 0.21), ev("sphs", 0.01)], 25);
    expect(t.kind).toBe("ambiguous");
    if (t.kind === "ambiguous") expect(t.candidates.map((c) => c.id)).toEqual(["sphs", "church"]);
  });
  it("one fair close by → single", () => {
    expect(classifySnapTarget([ev("a", 0.4), ev("b", 4)], 25)).toEqual({
      kind: "single",
      event: ev("a", 0.4),
    });
  });
  it("a second fair 3 mi away becomes a candidate only when the fix is that poor", () => {
    expect(classifySnapTarget([ev("a", 0.1), ev("b", 3)], 25).kind).toBe("single");
    expect(classifySnapTarget([ev("a", 0.1), ev("b", 3)], 3000).kind).toBe("ambiguous");
  });
  it("location-free rows and duplicates do not count", () => {
    expect(classifySnapTarget([ev("a", null), ev("b", null)], 25).kind).toBe("none");
    expect(classifySnapTarget([ev("a", 0.1), ev("a", 0.1)], 25).kind).toBe("single");
  });
});

describe("parseSnapChoiceBasis", () => {
  it("accepts only the three client values", () => {
    expect(parseSnapChoiceBasis("picked")).toBe("picked");
    expect(parseSnapChoiceBasis("auto_nearest_ambiguous")).toBeNull(); // server-only
    expect(parseSnapChoiceBasis(undefined)).toBeNull();
    expect(parseSnapChoiceBasis(1)).toBeNull();
  });
});
