import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isoDaysAgo } from "../shared";
import type { SparklineSeries } from "../types";
import { chartDaysForWindow, chartPointsSince } from "../window-series";

const series = (ages: number[]): SparklineSeries =>
  ages.map((age) => ({ date: isoDaysAgo(age), value: 1 }));

describe("Overview chart window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("draws at least a week", () => {
    expect([1, 7, 30, 90].map(chartDaysForWindow)).toEqual([7, 7, 30, 90]);
  });

  it("keeps exactly the last N calendar days", () => {
    const points = series([40, 30, 29, 3, 0]);
    expect(chartPointsSince(points, 30).map((p) => p.date)).toEqual([
      isoDaysAgo(29),
      isoDaysAgo(3),
      isoDaysAgo(0),
    ]);
  });

  it("cuts by date, so a series with a trimmed tail is not stretched back", () => {
    // GSC lag: the newest point is 3 days old. Counting 7 points would keep day 9.
    const points = series([9, 8, 7, 6, 5, 4, 3]);
    expect(chartPointsSince(points, 7)).toHaveLength(4);
  });

  it("keeps the unavailable tag, so a failed load is not read as 0", () => {
    const failed: SparklineSeries = Object.assign(series([1, 0]), {
      unavailableReason: "GSC unavailable — 503",
    });
    expect(chartPointsSince(failed, 7).unavailableReason).toBe("GSC unavailable — 503");
  });
});
