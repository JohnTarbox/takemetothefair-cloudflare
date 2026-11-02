/**
 * OPE-1565 — the admin chart options. These pin the acceptance rules that are
 * properties of the OPTION (what ECharts is told), so they hold without a DOM:
 * fixed-pixel text ≥ 10px at every width class, library-owned collision
 * handling, OPE-456's hollow/solid dots, tooltips that carry value + date +
 * derived-vs-awarded, and no throw on empty data (OPE-242).
 *
 * What they cannot pin: actual on-screen overlap at 360–1920px. That is the
 * library's `hideOverlap` doing its job, and is checked by eye on the deployed
 * admin page, not here.
 */
import { describe, it, expect } from "vitest";
import {
  MIN_CHART_FONT_PX,
  accuracyOption,
  dailyViewsOption,
  milestoneChartOption,
  niceCeil,
  type ChartCtx,
  type MilestoneChartPoint,
} from "../echarts-options";

const WIDE: ChartCtx = { narrow: false, dark: false };
const NARROW: ChartCtx = { narrow: true, dark: false };
const DARK: ChartCtx = { narrow: false, dark: true };

/** Every `fontSize` anywhere in the option object. */
function fontSizes(o: unknown, out: number[] = []): number[] {
  if (Array.isArray(o)) o.forEach((x) => fontSizes(x, out));
  else if (o && typeof o === "object") {
    for (const [k, v] of Object.entries(o)) {
      if (k === "fontSize" && typeof v === "number") out.push(v);
      else fontSizes(v, out);
    }
  }
  return out;
}

// Shape of the live series on 2026-11-02: 42 points, 100 → 31,000, mixed sources.
const thresholds = [
  100, 150, 200, 250, 300, 350, 400, 500, 600, 700, 800, 900, 1000, 1500, 2000, 2500, 3000, 3500,
  4000, 4500, 5000, 5500, 6000, 7000, 8000, 9000, 10000, 11000, 12000, 13000, 14000, 15000, 16000,
  17000, 18000, 20000, 22000, 25000, 27000, 29000, 30000, 31000,
];
const LIVE_SHAPE: MilestoneChartPoint[] = thresholds.map((t, i) => ({
  threshold: t,
  dateLabel: `Day ${i + 1}`,
  derived: i % 2 === 0,
}));

describe("milestoneChartOption (OPE-1565)", () => {
  it("every text size is a fixed px ≥ 10, narrow and wide (was ~5px on a 380px phone)", () => {
    for (const ctx of [WIDE, NARROW, DARK]) {
      const sizes = fontSizes(milestoneChartOption(LIVE_SHAPE, ctx));
      expect(sizes.length).toBeGreaterThan(3); // landmark: the walk found them
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(MIN_CHART_FONT_PX);
    }
  });

  it("collision handling is the library's: hideOverlap on point labels and the x axis", () => {
    const o = milestoneChartOption(LIVE_SHAPE, WIDE);
    expect(o.series[0].labelLayout).toEqual({ hideOverlap: true });
    expect(o.xAxis.axisLabel.hideOverlap).toBe(true);
  });

  it("x axis is index-spaced (category) — the measured reached_date gap", () => {
    const o = milestoneChartOption(LIVE_SHAPE, WIDE);
    expect(o.xAxis.type).toBe("category");
    expect(o.xAxis.data).toHaveLength(42);
  });

  it("the last point is labelled by endLabel only, so 29,000 and 31,000 cannot overprint", () => {
    const o = milestoneChartOption(LIVE_SHAPE, WIDE);
    const data = o.series[0].data;
    expect(data[data.length - 1].label.show).toBe(false);
    expect(data[data.length - 2].label.show).toBe(true);
    expect(o.series[0].endLabel.show).toBe(true);
    expect(o.series[0].endLabel.formatter()).toBe("31,000");
  });

  it("OPE-456: hollow dot = derived, solid = Google badge", () => {
    const data = milestoneChartOption(LIVE_SHAPE, WIDE).series[0].data;
    const derived = data[0]; // i=0 derived
    const badge = data[1];
    expect(derived.itemStyle.borderWidth).toBe(2);
    expect(derived.itemStyle.color).not.toBe(derived.itemStyle.borderColor);
    expect(badge.itemStyle.borderWidth).toBe(0);
    expect(badge.itemStyle.color).toBe(badge.itemStyle.borderColor);
  });

  it("tooltip shows value, date and derived-vs-awarded", () => {
    const o = milestoneChartOption(LIVE_SHAPE, WIDE);
    const data = o.series[0].data;
    expect(o.tooltip.formatter({ data: data[0] })).toBe(
      "100 clicks — Day 1<br/>Derived from our own daily totals"
    );
    expect(o.tooltip.formatter({ data: data[41] })).toBe(
      "31,000 clicks — Day 42<br/>Badge awarded by Google"
    );
  });

  it("log axis spans the data: 100 → 50K for the live shape", () => {
    const o = milestoneChartOption(LIVE_SHAPE, WIDE);
    expect(o.yAxis.min).toBe(100);
    expect(o.yAxis.max).toBe(50000);
  });

  it("does not throw on empty data (OPE-242)", () => {
    expect(() => milestoneChartOption([], WIDE)).not.toThrow();
    expect(milestoneChartOption([], WIDE).series[0].endLabel.show).toBe(false);
  });
});

describe("dailyViewsOption (OPE-1565)", () => {
  const rows = [
    { dateLabel: "2026-10-01", views: 1200, users: 800 },
    { dateLabel: "2026-10-02", views: 1350, users: 900 },
  ];
  it("text ≥ 10px; tooltip shows the day's views and users", () => {
    const o = dailyViewsOption(rows, NARROW);
    expect(Math.min(...fontSizes(o))).toBeGreaterThanOrEqual(MIN_CHART_FONT_PX);
    expect(o.tooltip.formatter([{ dataIndex: 1 }])).toBe("2026-10-02<br/>1,350 views, 900 users");
  });
  it("does not throw on empty data", () => {
    expect(() => dailyViewsOption([], WIDE)).not.toThrow();
  });
});

describe("accuracyOption (OPE-1565)", () => {
  const b = (weekStart: string, v: string, pct: number | null) => ({
    weekStart,
    classifierVersion: v,
    total: 10,
    disagreements: pct === null ? 0 : 10 - pct / 10,
    accuracyPct: pct,
  });
  const buckets = [
    b("2026-10-05", "v1", 80),
    b("2026-10-12", "v1", 90),
    b("2026-10-19", "v1", 70),
    // v2 starts mid-window — the SVG drew it at weeks 1–2 instead of 2–3.
    b("2026-10-12", "v2", 60),
    b("2026-10-19", "v2", 100),
  ];
  it("aligns every version on weekStart, not on array index", () => {
    const o = accuracyOption(buckets, ["v1", "v2"], WIDE);
    expect(o.xAxis.data).toEqual(["10-05", "10-12", "10-19"]);
    expect(o.series[1].data).toEqual([null, 60, 100]);
    expect(o.series[0].data).toEqual([80, 90, 70]);
  });
  it("has a legend, text ≥ 10px, and a per-version tooltip", () => {
    const o = accuracyOption(buckets, ["v1", "v2"], NARROW);
    expect(o.legend).toBeDefined();
    expect(Math.min(...fontSizes(o))).toBeGreaterThanOrEqual(MIN_CHART_FONT_PX);
    const tip = o.tooltip.formatter([
      { seriesName: "v1", dataIndex: 1, marker: "" },
      { seriesName: "v2", dataIndex: 1, marker: "" },
    ]);
    expect(tip).toBe("Week of 2026-10-12<br/>v1: 90% (9/10)<br/>v2: 60% (6/10)");
  });
  it("does not throw on empty data", () => {
    expect(() => accuracyOption([], [], WIDE)).not.toThrow();
  });
});

describe("niceCeil", () => {
  it("rounds up to 1/2/5 × 10^k", () => {
    expect(niceCeil(37200)).toBe(50000);
    expect(niceCeil(1000)).toBe(1000);
    expect(niceCeil(1001)).toBe(2000);
    expect(niceCeil(0)).toBe(1);
  });
});
