/**
 * OPE-421 — the guard, and the six rows it must NOT flag.
 *
 * The headline test is `real places the broad heuristic got wrong`. Those six
 * values were returned by a Center/Park/Hall/state-code sweep against
 * production and are all correct data. A guard that rejected them would have
 * blocked legitimate venues at the write boundary; a bulk fix that "corrected"
 * them would have repeated OPE-219's four wrong pins.
 *
 * So the guard checks one separable thing — fairground naming — and these tests
 * exist mainly to hold that line against a future "improvement" that widens it.
 */
import { describe, expect, it } from "vitest";
import { checkVenueCityPlausibility } from "../venue-city-plausibility";

describe("the three genuinely wrong production values", () => {
  it.each(["Cummington Fairgrounds", "Fairgrounds at Lancaster", "West Springfield Big-E Grounds"])(
    "flags %s",
    (bad) => {
      expect(checkVenueCityPlausibility(bad).implausible).toBe(true);
    }
  );

  it("explains the consequence, not just the shape", () => {
    // The reason is what an operator reads. "Looks wrong" is not actionable;
    // "drops out of every city-keyed match" is.
    const r = checkVenueCityPlausibility("Cummington Fairgrounds");
    expect(r.reason).toMatch(/city-keyed match/);
  });
});

describe("real places the broad heuristic got wrong", () => {
  // Every one of these is a genuine value from production that a
  // Center/Park/Hall/state-code rule flagged. None may be rejected.
  it.each([
    "Winchester Center", // village, CT — already in the CT region list
    "Cumberland Center", // village, ME
    "Manchester Center", // village, VT
    "Hallowell", // town, ME — matched only on the letters "hall"
    "Winhall", // town, VT — same
    "Littleville", // village of Chester, MA — correct data
    "Center Harbor", // town, NH
    "Hyde Park", // village, VT
    "West Tisbury", // town, MA
  ])("%s is accepted", (city) => {
    expect(checkVenueCityPlausibility(city).implausible).toBe(false);
  });
});

describe("word-boundary discipline on 'grounds'", () => {
  it("does not fire on a town that merely contains the letters", () => {
    // `\bgrounds\b` rather than a substring: a hypothetical "Groundsville"
    // must pass, or this becomes another "hall" false positive.
    expect(checkVenueCityPlausibility("Groundsville").implausible).toBe(false);
    expect(checkVenueCityPlausibility("Groundswell").implausible).toBe(false);
  });

  it("still fires on the standalone word", () => {
    expect(checkVenueCityPlausibility("Big-E Grounds").implausible).toBe(true);
  });
});

describe("it refuses, and does not propose a replacement", () => {
  it("exposes no suggestion field at all", () => {
    // An earlier version parsed a best-guess town out of the bad value. Its own
    // tests caught it emitting "West Springfield Big-E" and "The" — confident,
    // wrong, and exactly what a caller would write unattended. Repair needs a
    // gazetteer and the row's coordinates (OPE-425), not a regex.
    const r = checkVenueCityPlausibility("West Springfield Big-E Grounds") as unknown as Record<
      string,
      unknown
    >;
    expect(r.suggestion).toBeUndefined();
    expect(Object.keys(r).sort()).toEqual(["implausible", "reason"]);
  });

  it("still flags a value with no recoverable town", () => {
    expect(checkVenueCityPlausibility("The Fairgrounds").implausible).toBe(true);
  });
});

describe("empty input", () => {
  it("treats blank/missing as not-implausible — absence is a different defect", () => {
    for (const v of ["", "   ", null, undefined]) {
      expect(checkVenueCityPlausibility(v).implausible, String(v)).toBe(false);
    }
  });
});
