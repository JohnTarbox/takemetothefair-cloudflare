/**
 * Tests for GW1.2 (2026-06-03) reliability-weighted resolution.
 *
 * Covers the decision rule's full matrix:
 *   - winner=candidate (above margin, flag on/off → 'flipped' vs 'would_flip')
 *   - winner=existing (above margin → 'existing_won', no flip)
 *   - below_margin (regardless of direction)
 *   - unknown_source (either side null)
 *
 * The DB-bound `lookupReliability` and the route wiring are exercised
 * separately — keeping this file pure means fast feedback on the
 * decision logic, where most of the subtle bugs would land.
 */

import { describe, it, expect } from "vitest";
import {
  decideResolution,
  formatResolutionNotes,
  RELIABILITY_FLIP_MARGIN,
} from "../reliability-resolution";

const baseInput = {
  fieldClass: "date" as const,
  candidateSourceKey: "candidate.com",
  existingSourceKey: "existing.com",
};

describe("decideResolution — margin direction", () => {
  it("returns 'flipped' when candidate exceeds existing by ≥ margin AND flag is set", () => {
    const r = decideResolution({
      ...baseInput,
      candidateScore: 0.92,
      existingScore: 0.65,
      flipEnabled: true,
    });
    expect(r.winner).toBe("candidate");
    expect(r.reason).toBe("flipped");
    expect(r.marginAbs).toBeCloseTo(0.27, 2);
  });

  it("returns 'would_flip' when candidate exceeds existing by ≥ margin BUT flag is unset", () => {
    const r = decideResolution({
      ...baseInput,
      candidateScore: 0.92,
      existingScore: 0.65,
      flipEnabled: false,
    });
    expect(r.winner).toBe("candidate");
    expect(r.reason).toBe("would_flip");
  });

  it("returns 'existing_won' when existing exceeds candidate by ≥ margin (no flip needed regardless of flag)", () => {
    const r1 = decideResolution({
      ...baseInput,
      candidateScore: 0.55,
      existingScore: 0.85,
      flipEnabled: true,
    });
    expect(r1.winner).toBe("existing");
    expect(r1.reason).toBe("existing_won");

    const r2 = decideResolution({
      ...baseInput,
      candidateScore: 0.55,
      existingScore: 0.85,
      flipEnabled: false,
    });
    expect(r2.winner).toBe("existing");
    expect(r2.reason).toBe("existing_won");
  });
});

describe("decideResolution — margin threshold", () => {
  it(`treats |gap| < ${RELIABILITY_FLIP_MARGIN} as below_margin`, () => {
    // 0.19 gap → below the 0.2 threshold
    const r = decideResolution({
      ...baseInput,
      candidateScore: 0.81,
      existingScore: 0.62,
      flipEnabled: true,
    });
    expect(r.winner).toBeNull();
    expect(r.reason).toBe("below_margin");
    expect(r.marginAbs).toBeCloseTo(0.19, 2);
  });

  it("treats exactly-equal scores as below_margin", () => {
    const r = decideResolution({
      ...baseInput,
      candidateScore: 0.7,
      existingScore: 0.7,
      flipEnabled: true,
    });
    expect(r.winner).toBeNull();
    expect(r.reason).toBe("below_margin");
    expect(r.marginAbs).toBe(0);
  });

  it("treats |gap| === margin as winning (>=, not >)", () => {
    // Exactly 0.2 — design choice: at-margin should flip. Picking the
    // boundary side that's more likely to ship useful auto-corrections
    // (the alternative — strict >, never-flip-at-boundary — would
    // refuse genuine 0.2-gap wins).
    const r = decideResolution({
      ...baseInput,
      candidateScore: 0.9,
      existingScore: 0.7,
      flipEnabled: true,
    });
    expect(r.reason).toBe("flipped");
  });

  it("honors a caller-supplied custom margin", () => {
    const r = decideResolution({
      ...baseInput,
      candidateScore: 0.86,
      existingScore: 0.81,
      margin: 0.04,
      flipEnabled: true,
    });
    expect(r.reason).toBe("flipped"); // 0.05 > 0.04 custom margin
  });
});

describe("decideResolution — unknown source", () => {
  it("returns unknown_source when candidate has no reliability row", () => {
    const r = decideResolution({
      ...baseInput,
      candidateScore: null,
      existingScore: 0.85,
      flipEnabled: true,
    });
    expect(r.winner).toBeNull();
    expect(r.reason).toBe("unknown_source");
    expect(r.marginAbs).toBeNull();
  });

  it("returns unknown_source when existing has no reliability row", () => {
    const r = decideResolution({
      ...baseInput,
      candidateScore: 0.9,
      existingScore: null,
      flipEnabled: true,
    });
    expect(r.winner).toBeNull();
    expect(r.reason).toBe("unknown_source");
  });

  it("returns unknown_source when BOTH sources lack reliability rows", () => {
    const r = decideResolution({
      ...baseInput,
      candidateScore: null,
      existingScore: null,
      flipEnabled: true,
    });
    expect(r.winner).toBeNull();
    expect(r.reason).toBe("unknown_source");
  });
});

describe("formatResolutionNotes", () => {
  it("includes both scores and the reason", () => {
    const r = decideResolution({
      ...baseInput,
      candidateScore: 0.91,
      existingScore: 0.61,
      flipEnabled: true,
    });
    expect(formatResolutionNotes(r)).toBe(" [gw1.2 flipped: c=0.91 vs e=0.61]");
  });

  it("renders null scores explicitly", () => {
    const r = decideResolution({
      ...baseInput,
      candidateScore: null,
      existingScore: 0.85,
      flipEnabled: true,
    });
    expect(formatResolutionNotes(r)).toBe(" [gw1.2 unknown_source: c=null vs e=0.85]");
  });

  it("uses 2-decimal score formatting", () => {
    const r = decideResolution({
      ...baseInput,
      candidateScore: 0.999999,
      existingScore: 0.123456,
      flipEnabled: false,
    });
    expect(formatResolutionNotes(r)).toBe(" [gw1.2 would_flip: c=1.00 vs e=0.12]");
  });
});
