/**
 * Threshold classification tests. Covers each of the 5 KPIs across the
 * three boundary regions (below-RED / between / above-GREEN) for both
 * higher_better and lower_better directions, plus null → INDETERMINATE
 * and STALE precedence over value-based classification.
 */
import { describe, it, expect } from "vitest";
import { classifyKpi, formatStaleAge, KPI_THRESHOLDS, KPI_NAMES } from "../kpi-thresholds";

const FRESH = 60; // 1m old data — never STALE for any KPI
const STALE_HOURS = (h: number) => h * 3600;

describe("classifyKpi", () => {
  it("returns INDETERMINATE for null and non-finite values when fresh", () => {
    expect(classifyKpi("site_ctr", null, FRESH)).toBe("INDETERMINATE");
    expect(classifyKpi("site_ctr", NaN, FRESH)).toBe("INDETERMINATE");
    expect(classifyKpi("site_ctr", Infinity, FRESH)).toBe("INDETERMINATE");
  });

  it("higher_better: GREEN at green boundary, RED below red", () => {
    // site_ctr: green=0.02, red=0.01
    expect(classifyKpi("site_ctr", 0.02, FRESH)).toBe("GREEN");
    expect(classifyKpi("site_ctr", 0.05, FRESH)).toBe("GREEN");
    expect(classifyKpi("site_ctr", 0.015, FRESH)).toBe("YELLOW");
    expect(classifyKpi("site_ctr", 0.01, FRESH)).toBe("YELLOW"); // boundary: not below red
    expect(classifyKpi("site_ctr", 0.0099, FRESH)).toBe("RED");
    expect(classifyKpi("site_ctr", 0, FRESH)).toBe("RED");
  });

  it("higher_better: covers conversion_rate and sitemap_quality", () => {
    expect(classifyKpi("conversion_rate", 0.08, FRESH)).toBe("GREEN");
    expect(classifyKpi("conversion_rate", 0.06, FRESH)).toBe("YELLOW");
    expect(classifyKpi("conversion_rate", 0.04, FRESH)).toBe("RED");
    expect(classifyKpi("sitemap_quality", 0.9, FRESH)).toBe("GREEN");
    expect(classifyKpi("sitemap_quality", 0.7, FRESH)).toBe("YELLOW");
    expect(classifyKpi("sitemap_quality", 0.5, FRESH)).toBe("RED");
  });

  it("lower_better: brand_share — high values are RED", () => {
    // brand_share: green=0.4, red=0.6 (lower is better)
    expect(classifyKpi("brand_share", 0.3, FRESH)).toBe("GREEN");
    expect(classifyKpi("brand_share", 0.4, FRESH)).toBe("GREEN"); // boundary
    expect(classifyKpi("brand_share", 0.5, FRESH)).toBe("YELLOW");
    expect(classifyKpi("brand_share", 0.6, FRESH)).toBe("YELLOW"); // boundary
    expect(classifyKpi("brand_share", 0.61, FRESH)).toBe("RED");
    expect(classifyKpi("brand_share", 0.86, FRESH)).toBe("RED"); // current prod state
  });

  it("lower_better: time_to_index_h thresholds in hours", () => {
    expect(classifyKpi("time_to_index_h", 12, FRESH)).toBe("GREEN");
    expect(classifyKpi("time_to_index_h", 24, FRESH)).toBe("GREEN"); // boundary
    expect(classifyKpi("time_to_index_h", 48, FRESH)).toBe("YELLOW");
    expect(classifyKpi("time_to_index_h", 72, FRESH)).toBe("YELLOW"); // boundary
    expect(classifyKpi("time_to_index_h", 96, FRESH)).toBe("RED");
  });

  describe("STALE precedence", () => {
    // GSC has 2-3d natural reporting lag → SLA bumped to 120h (5d) in
    // Phase 2.1; below those values is healthy, above is STALE.
    it("returns STALE for site_ctr when GSC data > 120h old, regardless of value", () => {
      expect(classifyKpi("site_ctr", 0.05, STALE_HOURS(121))).toBe("STALE");
      expect(classifyKpi("site_ctr", 0.001, STALE_HOURS(200))).toBe("STALE");
    });

    it("site_ctr 120h boundary: 120h exact = healthy, 120h+1s = STALE", () => {
      expect(classifyKpi("site_ctr", 0.05, 120 * 3600)).toBe("GREEN");
      expect(classifyKpi("site_ctr", 0.05, 120 * 3600 + 1)).toBe("STALE");
    });

    it("conversion_rate has 96h SLA (GA4 finalization lag + grace)", () => {
      expect(classifyKpi("conversion_rate", 0.09, STALE_HOURS(95))).toBe("GREEN");
      expect(classifyKpi("conversion_rate", 0.09, STALE_HOURS(97))).toBe("STALE");
    });

    it("sitemap_quality has 1h SLA — fast catalog turnover required", () => {
      expect(classifyKpi("sitemap_quality", 0.9, 30 * 60)).toBe("GREEN");
      expect(classifyKpi("sitemap_quality", 0.9, 2 * 3600)).toBe("STALE");
    });

    it("time_to_index_h has 7d SLA — slow pipeline tolerance", () => {
      expect(classifyKpi("time_to_index_h", 12, 6 * 24 * 3600)).toBe("GREEN");
      expect(classifyKpi("time_to_index_h", 12, 8 * 24 * 3600)).toBe("STALE");
    });

    it("dataAgeSeconds=null bypasses STALE check (freshness unknown)", () => {
      // When we can't measure freshness, fall through to value-based classification.
      expect(classifyKpi("site_ctr", 0.05, null)).toBe("GREEN");
      expect(classifyKpi("site_ctr", null, null)).toBe("INDETERMINATE");
    });
  });

  it("KPI_NAMES enumerates exactly the keys of KPI_THRESHOLDS", () => {
    expect(new Set(KPI_NAMES)).toEqual(new Set(Object.keys(KPI_THRESHOLDS)));
  });

  it("every KPI has a non-empty effort, action description, target label, and SLA", () => {
    for (const name of KPI_NAMES) {
      const t = KPI_THRESHOLDS[name];
      expect(t.effort.length).toBeGreaterThan(0);
      expect(t.actionDescription.length).toBeGreaterThan(0);
      expect(t.targetLabel.length).toBeGreaterThan(0);
      expect(t.displayName.length).toBeGreaterThan(0);
      expect(t.staleSlaSeconds).toBeGreaterThan(0);
    }
  });
});

describe("formatStaleAge", () => {
  it("formats minutes for sub-hour ages", () => {
    expect(formatStaleAge(120)).toBe("2m");
    expect(formatStaleAge(1800)).toBe("30m");
  });
  it("formats hours for sub-day ages", () => {
    expect(formatStaleAge(7200)).toBe("2h");
    expect(formatStaleAge(23 * 3600)).toBe("23h");
  });
  it("formats days for ages >= 24h", () => {
    expect(formatStaleAge(2 * 86400)).toBe("2d");
    expect(formatStaleAge(7 * 86400)).toBe("7d");
    expect(formatStaleAge(73 * 3600)).toBe("3d"); // 73h crosses into day-display
  });
});
