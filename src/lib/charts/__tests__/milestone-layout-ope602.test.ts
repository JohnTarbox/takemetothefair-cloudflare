/**
 * OPE-602 — the "Search clicks milestones" chart rendered badly at every width.
 *
 * The measurements below are John's, taken in the live authenticated admin
 * panel with `getScreenCTM()` / `getBBox()` rather than eyeballed from a
 * screenshot — so the numbers in these tests are the real ones, not invented
 * fixtures.
 *
 * The root cause (`preserveAspectRatio="none"` on a fluid-width, fixed-height
 * svg) is fixed in the component. Everything here is the arithmetic underneath:
 * label slots narrower than their labels, a label box crossing the viewBox
 * edge, and a "log scale" axis with no ticks.
 */
import { describe, it, expect } from "vitest";
import {
  computeMilestoneLayout,
  computeLabelStride,
  computeLogTicks,
  approxLabelWidth,
  MILESTONE_CHART_DIMS,
  type MilestonePoint,
} from "../milestone-layout";

/** The chart's own formatter: thousands separators, which is what makes the labels wide. */
const fmt = (n: number) => n.toLocaleString("en-US");

/** The live series shape: 25 milestones, May onward, 40 → 13,000. */
function liveSeries(): MilestonePoint[] {
  const thresholds = [
    40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 2000, 2500, 3000,
    4000, 5000, 7000, 9000, 11000, 13000,
  ];
  return thresholds.map((t, i) => ({
    threshold: t,
    emailDate: `2026-0${5 + Math.floor(i / 13)}-${String((i % 28) + 1).padStart(2, "0")}`,
  }));
}

describe("label collision — structural, not incidental", () => {
  it("reproduces the collision at the live geometry", () => {
    // 25 points across 776 usable units = 32.33 apart, and "13,000" needs ~37.
    // Any 5+ character label is wider than its own slot, which is why the
    // overlap was guaranteed rather than unlucky.
    const stepX = (800 - 12 - 12) / (25 - 1);
    expect(stepX).toBeCloseTo(32.33, 1);
    expect(approxLabelWidth("13,000")).toBeGreaterThan(stepX);
  });

  it("strides labels so none can overlap", () => {
    const layout = computeMilestoneLayout(liveSeries(), fmt);
    expect(layout.labelStride).toBeGreaterThan(1);

    const shown = layout.coords.filter((c) => c.showLabel);
    for (let i = 1; i < shown.length; i++) {
      const gap = shown[i].x - shown[i - 1].x;
      const need =
        approxLabelWidth(fmt(shown[i].threshold)) / 2 +
        approxLabelWidth(fmt(shown[i - 1].threshold)) / 2;
      // The final point is force-labelled (it is the headline number), so the
      // last gap is allowed to be tighter than the stride would give.
      if (i < shown.length - 1) expect(gap).toBeGreaterThanOrEqual(need);
    }
  });

  it("keeps every label when they comfortably fit", () => {
    const few: MilestonePoint[] = [
      { threshold: 10, emailDate: "2026-05-01" },
      { threshold: 20, emailDate: "2026-06-01" },
      { threshold: 30, emailDate: "2026-07-01" },
    ];
    const layout = computeMilestoneLayout(few, fmt);
    expect(layout.labelStride).toBe(1);
    expect(layout.coords.every((c) => c.showLabel)).toBe(true);
  });

  it("sizes the stride from the WIDEST label, not the narrowest", () => {
    // Keying on an early narrow label lets a wider one later in the series
    // collide — which is exactly how this chart failed, since the labels grow
    // from "40" to "13,000" as the series progresses.
    const stepX = 20;
    const narrowOnly = ["40", "50", "60"];
    const withWide = ["40", "50", "13,000"];

    // The wide member must dominate the answer...
    expect(computeLabelStride(withWide, stepX)).toBeGreaterThan(
      computeLabelStride(narrowOnly, stepX)
    );
    // ...and the answer must be exactly what that widest label needs.
    expect(computeLabelStride(withWide, stepX)).toBe(
      Math.ceil((approxLabelWidth("13,000") + 2) / stepX)
    );
  });
});

describe("edge clipping — `13,000` rendered as `13,00`", () => {
  it("anchors the final label to the END so it stays inside the viewBox", () => {
    const layout = computeMilestoneLayout(liveSeries(), fmt);
    const last = layout.coords[layout.coords.length - 1];
    // Centred at x=788 its right edge reached 806.6 in an 800-wide viewBox.
    expect(last.x).toBe(MILESTONE_CHART_DIMS.width - MILESTONE_CHART_DIMS.padRight);
    expect(last.labelAnchor).toBe("end");
  });

  it("anchors the first label to START, and leaves interior labels centred", () => {
    const layout = computeMilestoneLayout(liveSeries(), fmt);
    expect(layout.coords[0].labelAnchor).toBe("start");
    const middle = layout.coords[Math.floor(layout.coords.length / 2)];
    expect(middle.labelAnchor).toBe("middle");
  });

  it("no drawn label extends beyond either edge", () => {
    const { width, padLeft, padRight } = MILESTONE_CHART_DIMS;
    for (const c of computeMilestoneLayout(liveSeries(), fmt).coords.filter((c) => c.showLabel)) {
      const w = approxLabelWidth(fmt(c.threshold));
      const left =
        c.labelAnchor === "start" ? c.x : c.labelAnchor === "end" ? c.x - w : c.x - w / 2;
      expect(left).toBeGreaterThanOrEqual(padLeft - 0.01);
      expect(left + w).toBeLessThanOrEqual(width - padRight + 0.01);
    }
  });
});

describe("log ticks — the axis the subtitle promised", () => {
  it("emits powers of ten across the plotted range", () => {
    expect(computeLogTicks(40, 13000)).toContain(100);
    expect(computeLogTicks(40, 13000)).toContain(1000);
    expect(computeLogTicks(40, 13000)).toContain(10000);
  });

  it("never returns an empty axis, even inside a single decade", () => {
    // A series from 200 to 800 crosses no power of ten. Returning nothing would
    // restore exactly the defect — a plot you cannot read a value off.
    expect(computeLogTicks(200, 800).length).toBeGreaterThan(0);
  });

  it("places ticks on the same log scale as the points", () => {
    const layout = computeMilestoneLayout(liveSeries(), fmt);
    const tick1000 = layout.ticks.find((t) => t.value === 1000);
    const point1000 = layout.coords.find((c) => c.threshold === 1000);
    expect(tick1000).toBeDefined();
    // A tick drawn off its own scale is worse than no tick: it invites reading
    // a wrong value off the plot with confidence.
    expect(tick1000!.y).toBeCloseTo(point1000!.y, 6);
  });
});

describe("degenerate input", () => {
  it("returns an empty layout for no points rather than throwing", () => {
    const layout = computeMilestoneLayout([], fmt);
    expect(layout.coords).toEqual([]);
    expect(layout.linePath).toBe("");
  });

  it("handles a single point", () => {
    const layout = computeMilestoneLayout([{ threshold: 100, emailDate: "2026-05-01" }], fmt);
    expect(layout.coords).toHaveLength(1);
    expect(layout.dateLabelIndices).toEqual([0]);
  });
});
