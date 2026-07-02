import { describe, it, expect } from "vitest";
import { areDatesContiguous } from "./date-contiguity";

describe("areDatesContiguous", () => {
  it("returns true for an empty list (safe default → not discontinuous)", () => {
    expect(areDatesContiguous([])).toBe(true);
  });

  it("returns true for a single date", () => {
    expect(areDatesContiguous(["2026-07-04"])).toBe(true);
  });

  it("returns true for a gap-free consecutive run", () => {
    expect(areDatesContiguous(["2026-07-04", "2026-07-05", "2026-07-06"])).toBe(true);
  });

  it("returns true regardless of input order (sorted internally)", () => {
    expect(areDatesContiguous(["2026-07-06", "2026-07-04", "2026-07-05"])).toBe(true);
  });

  it("returns true across a month boundary (Jul 31 → Aug 1)", () => {
    expect(areDatesContiguous(["2026-07-31", "2026-08-01"])).toBe(true);
  });

  it("returns false for weekly (every-Saturday) dates — the bug case", () => {
    expect(areDatesContiguous(["2026-06-06", "2026-06-13", "2026-06-20"])).toBe(false);
  });

  it("returns false for a single one-day gap", () => {
    expect(areDatesContiguous(["2026-07-04", "2026-07-06"])).toBe(false);
  });

  it("returns false for biweekly/monthly cadence", () => {
    expect(areDatesContiguous(["2026-01-15", "2026-02-15", "2026-03-15"])).toBe(false);
  });

  it("returns false when any date is unparseable (conservative)", () => {
    expect(areDatesContiguous(["2026-07-04", "not-a-date"])).toBe(false);
  });

  it("returns false for a non-existent calendar date (Feb 31)", () => {
    expect(areDatesContiguous(["2026-02-31", "2026-03-01"])).toBe(false);
  });

  it("collapses a duplicate date rather than reading it as a 0-day gap", () => {
    // Two copies of Jul 4 plus Jul 5 → still a contiguous {Jul 4, Jul 5} run.
    expect(areDatesContiguous(["2026-07-04", "2026-07-04", "2026-07-05"])).toBe(true);
    // A duplicate on its own de-dups to a single date → contiguous.
    expect(areDatesContiguous(["2026-07-04", "2026-07-04"])).toBe(true);
  });
});
