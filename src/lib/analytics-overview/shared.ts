/**
 * Internal helpers + shared constants for the analytics-overview domain
 * modules. Not part of the public surface — consumers import the snapshot
 * from the package entry point. Domain modules import the helpers they need
 * from here so the day-series math and window arithmetic live in one place.
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import type { SparklinePoint, Trend, WindowKey } from "./types";

export type Db = DrizzleD1Database<typeof schema>;

export const CONVERSION_EVENT_NAMES = [
  "outbound_ticket_click",
  "outbound_application_click",
] as const;

export const SPARKLINE_DAYS = 30;

export function windowDays(window: WindowKey): number {
  if (window === "1d") return 1;
  if (window === "7d") return 7;
  if (window === "30d") return 30;
  return 90;
}

export function trendOf(current: number, previous: number): Trend {
  if (current > previous) return "up";
  if (current < previous) return "down";
  return "flat";
}

export function isoDaysAgo(d: number): string {
  const dt = new Date();
  dt.setUTCDate(dt.getUTCDate() - d);
  return dt.toISOString().slice(0, 10);
}

export function isoFromDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function emptyDailySeries(days: number): SparklinePoint[] {
  const points: SparklinePoint[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    points.push({ date: d.toISOString().slice(0, 10), value: 0 });
  }
  return points;
}

export function fillDailySeries(rawByDate: Map<string, number>, days: number): SparklinePoint[] {
  const series = emptyDailySeries(days);
  for (const point of series) {
    point.value = rawByDate.get(point.date) ?? 0;
  }
  return series;
}

/**
 * Like fillDailySeries, but TRIMS the trailing days that have no row in
 * rawByDate yet — the ~2–3-day GSC/GA4 reporting lag (OPE-95). A day PRESENT in
 * rawByDate is kept even if its value is 0 (a real zero); only the unreported
 * tail is dropped, so a chart ends at the last day with data instead of drawing
 * a false cliff to zero. Interior gaps (rare) are left as 0. When rawByDate is
 * empty (no data at all) the full 0-series is returned unchanged, so the card
 * still renders a baseline rather than nothing. The last point's `date` is the
 * "data through" date the caller captions with.
 */
export function fillDailySeriesTrimTrailing(
  rawByDate: Map<string, number>,
  days: number
): SparklinePoint[] {
  const series = fillDailySeries(rawByDate, days);
  if (rawByDate.size === 0) return series;
  let end = series.length;
  while (end > 0 && !rawByDate.has(series[end - 1].date)) end--;
  return series.slice(0, end);
}
