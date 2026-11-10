/**
 * OPE-1602 — the Overview charts follow the window selector by trimming the
 * 90-day series the snapshot already loads, so a window change costs no queries.
 */
import { isoDaysAgo } from "./shared";
import type { SparklineSeries } from "./types";

/** One day is a dot, not a line, so the 1d window still draws a week. */
const MIN_CHART_DAYS = 7;

export function chartDaysForWindow(days: number): number {
  return Math.max(days, MIN_CHART_DAYS);
}

/**
 * The points in the last `days` calendar days, today included. It cuts by date
 * and not by count: GSC series have their unreported tail trimmed, so the last
 * 30 points would reach back further than 30 days.
 */
export function chartPointsSince(points: SparklineSeries, days: number): SparklineSeries {
  const cutoff = isoDaysAgo(days - 1);
  const kept = points.filter((p) => p.date >= cutoff);
  // filter() returns a plain array, which would drop the "GSC unavailable" tag
  // and let a failed load read as a real total of 0.
  return points.unavailableReason
    ? Object.assign(kept, { unavailableReason: points.unavailableReason })
    : kept;
}
