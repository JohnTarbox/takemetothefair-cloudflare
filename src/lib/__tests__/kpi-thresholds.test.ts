/**
 * Threshold classification tests. Covers each of the 5 KPIs across the
 * three boundary regions (below-RED / between / above-GREEN) for both
 * higher_better and lower_better directions, plus null → INDETERMINATE.
 */
import { describe, it, expect } from "vitest";
import { classifyKpi, KPI_THRESHOLDS, KPI_NAMES } from "../kpi-thresholds";

describe("classifyKpi", () => {
  it("returns INDETERMINATE for null and non-finite values", () => {
    expect(classifyKpi("site_ctr", null)).toBe("INDETERMINATE");
    expect(classifyKpi("site_ctr", NaN)).toBe("INDETERMINATE");
    expect(classifyKpi("site_ctr", Infinity)).toBe("INDETERMINATE");
  });

  it("higher_better: GREEN at green boundary, RED below red", () => {
    // site_ctr: green=0.02, red=0.01
    expect(classifyKpi("site_ctr", 0.02)).toBe("GREEN");
    expect(classifyKpi("site_ctr", 0.05)).toBe("GREEN");
    expect(classifyKpi("site_ctr", 0.015)).toBe("YELLOW");
    expect(classifyKpi("site_ctr", 0.01)).toBe("YELLOW"); // boundary: not below red
    expect(classifyKpi("site_ctr", 0.0099)).toBe("RED");
    expect(classifyKpi("site_ctr", 0)).toBe("RED");
  });

  it("higher_better: covers conversion_rate and sitemap_quality", () => {
    expect(classifyKpi("conversion_rate", 0.08)).toBe("GREEN");
    expect(classifyKpi("conversion_rate", 0.06)).toBe("YELLOW");
    expect(classifyKpi("conversion_rate", 0.04)).toBe("RED");
    expect(classifyKpi("sitemap_quality", 0.9)).toBe("GREEN");
    expect(classifyKpi("sitemap_quality", 0.7)).toBe("YELLOW");
    expect(classifyKpi("sitemap_quality", 0.5)).toBe("RED");
  });

  it("lower_better: brand_share — high values are RED", () => {
    // brand_share: green=0.4, red=0.6 (lower is better)
    expect(classifyKpi("brand_share", 0.3)).toBe("GREEN");
    expect(classifyKpi("brand_share", 0.4)).toBe("GREEN"); // boundary
    expect(classifyKpi("brand_share", 0.5)).toBe("YELLOW");
    expect(classifyKpi("brand_share", 0.6)).toBe("YELLOW"); // boundary
    expect(classifyKpi("brand_share", 0.61)).toBe("RED");
    expect(classifyKpi("brand_share", 0.86)).toBe("RED"); // current prod state
  });

  it("lower_better: time_to_index_h thresholds in hours", () => {
    expect(classifyKpi("time_to_index_h", 12)).toBe("GREEN");
    expect(classifyKpi("time_to_index_h", 24)).toBe("GREEN"); // boundary
    expect(classifyKpi("time_to_index_h", 48)).toBe("YELLOW");
    expect(classifyKpi("time_to_index_h", 72)).toBe("YELLOW"); // boundary
    expect(classifyKpi("time_to_index_h", 96)).toBe("RED");
  });

  it("KPI_NAMES enumerates exactly the keys of KPI_THRESHOLDS", () => {
    expect(new Set(KPI_NAMES)).toEqual(new Set(Object.keys(KPI_THRESHOLDS)));
  });

  it("every KPI has a non-empty effort, action description, and target label", () => {
    for (const name of KPI_NAMES) {
      const t = KPI_THRESHOLDS[name];
      expect(t.effort.length).toBeGreaterThan(0);
      expect(t.actionDescription.length).toBeGreaterThan(0);
      expect(t.targetLabel.length).toBeGreaterThan(0);
      expect(t.displayName.length).toBeGreaterThan(0);
    }
  });
});
