/**
 * OPE-637 — the self-tuning policy for the verification staleness window.
 *
 * John's 2026-08-14 constraint 3 asked for a periodic job that moves the
 * threshold on the observed `email_verified − created_at` distribution, with a
 * floor and a ceiling. It was never built, and no comment recorded it as
 * dropped.
 *
 * The bounds are the safety property, not a detail: this value governs a live
 * operator alert. Below the floor the queue indicts people who signed up an
 * hour ago; above the ceiling a real drop-off problem stays invisible for over
 * a week. So the tests that matter are the REFUSALS and the CLAMPS.
 */
import { describe, it, expect } from "vitest";
import {
  computeTunedGraceHours,
  clampGraceHours,
  VERIFICATION_GRACE_FLOOR_HOURS,
  VERIFICATION_GRACE_CEILING_HOURS,
  VERIFICATION_TUNE_MIN_SAMPLES,
  DEFAULT_VERIFICATION_GRACE_HOURS,
} from "../verification-threshold";

/** n samples all at the same delay, so the p90 is unambiguous. */
const flat = (n: number, hours: number) => Array.from({ length: n }, () => hours);

describe("refuses to move on thin evidence", () => {
  it("returns null below the minimum sample count", () => {
    // A handful of samples would let one unusual week swing the window across
    // its whole range — worse than leaving it where a human put it.
    expect(computeTunedGraceHours(flat(VERIFICATION_TUNE_MIN_SAMPLES - 1, 30))).toBeNull();
    expect(computeTunedGraceHours([])).toBeNull();
  });

  it("tunes once there are enough samples", () => {
    expect(computeTunedGraceHours(flat(VERIFICATION_TUNE_MIN_SAMPLES, 30))).toBe(30);
  });
});

describe("stays inside the floor and ceiling", () => {
  it("clamps UP a distribution that would shrink the window to nothing", () => {
    // Everyone confirms in two minutes → p90 ≈ 0.03h. Honouring that literally
    // would flag every signup within the hour.
    expect(computeTunedGraceHours(flat(50, 0.03))).toBe(VERIFICATION_GRACE_FLOOR_HOURS);
  });

  it("clamps DOWN a distribution that would hide a real problem", () => {
    // A month-long tail must not push the alert window to a month.
    expect(computeTunedGraceHours(flat(50, 720))).toBe(VERIFICATION_GRACE_CEILING_HOURS);
  });

  it("clamps directly too", () => {
    expect(clampGraceHours(1)).toBe(VERIFICATION_GRACE_FLOOR_HOURS);
    expect(clampGraceHours(9999)).toBe(VERIFICATION_GRACE_CEILING_HOURS);
    expect(clampGraceHours(48)).toBe(48);
  });
});

describe("tracks the p95, not the average", () => {
  it("is not dragged down by the majority who confirm immediately", () => {
    // 90 confirm in 5 minutes, 10 take 40 hours — the real shape of this
    // distribution. p90 is WRONG here and this test is why: the fast majority
    // defines it, so p90 = 5 minutes, the window clamps to the floor, and all
    // 10 slow-but-fine confirmers are reported stuck every day. p95 sits past
    // where nearly everyone who WILL confirm already has.
    const samples = [...flat(90, 0.08), ...flat(10, 40)];
    const tuned = computeTunedGraceHours(samples)!;
    expect(tuned).toBeGreaterThanOrEqual(40);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(tuned).toBeGreaterThan(mean);
  });

  it("returns a delay somebody actually experienced (nearest-rank, no interpolation)", () => {
    const samples = [...flat(50, 10), ...flat(50, 20)];
    expect(computeTunedGraceHours(samples)).toBe(20);
  });

  it("ignores negative and non-finite delays rather than trusting them", () => {
    // A clock skew or a NULL arithmetic artefact must not move an alert window.
    const samples = [...flat(30, 30), -5, NaN, Infinity];
    expect(computeTunedGraceHours(samples)).toBe(30);
  });
});

describe("the seed", () => {
  it("is 48, per constraint 2 — not the 24 that shipped", () => {
    expect(DEFAULT_VERIFICATION_GRACE_HOURS).toBe(48);
  });
});
