import { describe, it, expect } from "vitest";
import { computeTopDecileThreshold } from "../claimed-ready-for-enhanced-upsell";

describe("computeTopDecileThreshold", () => {
  it("returns 0 for empty input", () => {
    expect(computeTopDecileThreshold([])).toBe(0);
  });

  it("returns smallest value when N < 10 (return-all fallback)", () => {
    expect(computeTopDecileThreshold([100, 50, 10])).toBe(10);
    expect(computeTopDecileThreshold([42])).toBe(42);
    expect(computeTopDecileThreshold([5, 5, 5, 5])).toBe(5);
  });

  it("returns the view count at decile index when N == 10", () => {
    // ceil(10 * 0.1) - 1 = 0 → top-1 = first element
    const counts = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10];
    expect(computeTopDecileThreshold(counts)).toBe(100);
  });

  it("returns the view count at decile index when N == 20", () => {
    // ceil(20 * 0.1) - 1 = 1 → top-2 = second element
    const counts = Array.from({ length: 20 }, (_, i) => 200 - i * 10);
    // counts = [200, 190, 180, ...]
    expect(computeTopDecileThreshold(counts)).toBe(190);
  });

  it("returns the view count at decile index when N == 100", () => {
    // ceil(100 * 0.1) - 1 = 9 → top-10 = 10th element
    const counts = Array.from({ length: 100 }, (_, i) => 1000 - i);
    // counts = [1000, 999, ..., 901]
    expect(computeTopDecileThreshold(counts)).toBe(991); // 10th element (index 9)
  });

  it("handles ties at the threshold by returning the threshold value (caller filters >=)", () => {
    // Ties at the threshold position: caller will include all tied rows
    const counts = [100, 90, 90, 90, 80, 70, 60, 50, 40, 30];
    // ceil(10 * 0.1) - 1 = 0 → first = 100
    expect(computeTopDecileThreshold(counts)).toBe(100);

    const counts2 = [100, 100, 100, 80, 70, 60, 50, 40, 30, 20, 10];
    // N=11, ceil(11 * 0.1) - 1 = 1 → second = 100
    expect(computeTopDecileThreshold(counts2)).toBe(100);
  });

  it("handles all-zero view counts (post-deploy state)", () => {
    expect(computeTopDecileThreshold([0, 0, 0, 0, 0])).toBe(0);
  });

  it("handles non-round N (decile rounds up)", () => {
    // N=15, ceil(15 * 0.1) - 1 = 1 → second element
    const counts = [150, 140, 130, 120, 110, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10];
    expect(computeTopDecileThreshold(counts)).toBe(140);
  });

  it("N=11 boundary: just over the small-N threshold", () => {
    // N=11, ceil(11 * 0.1) - 1 = ceil(1.1) - 1 = 2 - 1 = 1 → second element
    const counts = [100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50];
    expect(computeTopDecileThreshold(counts)).toBe(95);
  });

  it("N=9 boundary: just under the small-N threshold", () => {
    // N=9 < 10 → smallest value
    const counts = [100, 95, 90, 85, 80, 75, 70, 65, 60];
    expect(computeTopDecileThreshold(counts)).toBe(60);
  });
});
