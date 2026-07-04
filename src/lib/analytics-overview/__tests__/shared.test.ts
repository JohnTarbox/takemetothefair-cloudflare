import { describe, it, expect } from "vitest";
import { fillDailySeriesTrimTrailing, emptyDailySeries } from "../shared";

/** Date string (YYYY-MM-DD) for `offset` days before today, matching the UTC
 *  arithmetic emptyDailySeries uses. */
function dayStr(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

describe("fillDailySeriesTrimTrailing (OPE-95)", () => {
  it("trims trailing days absent from the data (the GSC lag) so the series ends at the last real day", () => {
    // 10-day window; data for days 9..3 ago, nothing for 2/1/0 (the ~3-day lag).
    const byDate = new Map<string, number>();
    for (let i = 9; i >= 3; i--) byDate.set(dayStr(i), 10 + i);
    const series = fillDailySeriesTrimTrailing(byDate, 10);
    expect(series.length).toBe(7); // days 9..3, no phantom-zero tail
    expect(series[series.length - 1].date).toBe(dayStr(3));
  });

  it("keeps a real 0 day present in the map — only the unreported tail is trimmed", () => {
    const byDate = new Map<string, number>();
    for (let i = 9; i >= 3; i--) byDate.set(dayStr(i), i === 4 ? 0 : 10);
    const series = fillDailySeriesTrimTrailing(byDate, 10);
    expect(series.some((p) => p.date === dayStr(4) && p.value === 0)).toBe(true);
    expect(series[series.length - 1].date).toBe(dayStr(3));
  });

  it("returns the full 0-series when there is no data at all (baseline, not blank)", () => {
    const series = fillDailySeriesTrimTrailing(new Map(), 10);
    expect(series).toEqual(emptyDailySeries(10));
    expect(series.length).toBe(10);
  });
});
