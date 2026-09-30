/**
 * Conversion domain loaders: the row-1 Conversions delta, the 30-day
 * conversions sparkline, and the §6.3 conversion-rate card.
 */

import { and, count, gte, inArray, lt, sql } from "drizzle-orm";
import {
  insufficientAttributionReason,
  readOrganicConversionClicks,
} from "@/lib/analytics/organic-conversion-clicks";
import { analyticsEvents } from "@/lib/db/schema";
import { getOrganicSessions, type Ga4Env } from "@/lib/ga4";
import { freshness, rate as rateOf, unavailable } from "./render-state";
import {
  CONVERSION_EVENT_NAMES,
  SPARKLINE_DAYS,
  fillDailySeries,
  trendOf,
  type Db,
} from "./shared";
import type { ConversionRateCard, ConversionsCard, SparklinePoint } from "./types";

export async function loadConversions(
  db: Db,
  sinceDate: Date,
  priorStartDate: Date,
  priorEndDate: Date,
  days: number
): Promise<ConversionsCard> {
  const [currentRows, priorRows, beaconRows] = await Promise.all([
    db
      .select({ c: count() })
      .from(analyticsEvents)
      .where(
        and(
          inArray(analyticsEvents.eventName, [...CONVERSION_EVENT_NAMES]),
          gte(analyticsEvents.timestamp, sinceDate)
        )
      ),
    db
      .select({ c: count() })
      .from(analyticsEvents)
      .where(
        and(
          inArray(analyticsEvents.eventName, [...CONVERSION_EVENT_NAMES]),
          gte(analyticsEvents.timestamp, priorStartDate),
          lt(analyticsEvents.timestamp, priorEndDate)
        )
      ),
    // Freshness on the column that ADMITS rows (any event, not just
    // conversions — a quiet conversion week is real; a quiet beacon is not).
    db
      .select({ last: sql<number | null>`max(${analyticsEvents.timestamp})` })
      .from(analyticsEvents),
  ]);
  const current = currentRows[0]?.c ?? 0;
  const previous = priorRows[0]?.c ?? 0;
  const lastSec = beaconRows[0]?.last;
  return {
    current,
    previous,
    trend: trendOf(current, previous),
    windowDays: days,
    currentMeasured: freshness(
      current,
      "analytics_events",
      typeof lastSec === "number" ? lastSec * 1000 : null
    ),
  };
}

export async function loadConversionsSparkline(db: Db, sinceDate: Date): Promise<SparklinePoint[]> {
  // strftime expects seconds; columns store seconds (mode:"timestamp").
  const dayExpr = sql<string>`strftime('%Y-%m-%d', ${analyticsEvents.timestamp}, 'unixepoch')`;
  const rows = await db
    .select({
      day: dayExpr,
      c: count(),
    })
    .from(analyticsEvents)
    .where(
      and(
        inArray(analyticsEvents.eventName, [...CONVERSION_EVENT_NAMES]),
        gte(analyticsEvents.timestamp, sinceDate)
      )
    )
    .groupBy(dayExpr);

  const byDate = new Map<string, number>();
  for (const r of rows) byDate.set(r.day, r.c);
  return fillDailySeries(byDate, SPARKLINE_DAYS);
}

export async function loadConversionRate(
  db: Db,
  env: Ga4Env,
  days: number
): Promise<ConversionRateCard> {
  // §6.3 definition: outbound_ticket_click count / GA4 organic sessions, in
  // the 7d window ending 48h ago (matches the state classifier so the card
  // and the badge agree). Numerator reuses CONVERSION_EVENT_NAMES — same
  // source as the row-1 "Conversions" card.
  const STABLE_LAG_DAYS = 2;
  const nowMs = Date.now();
  const stableEndMs = nowMs - STABLE_LAG_DAYS * 86400 * 1000;
  const stableStartMs = stableEndMs - days * 86400 * 1000;
  const stableStartDate = new Date(stableStartMs);
  const stableEndDate = new Date(stableEndMs);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  // OPE-1165 — organic clicks ÷ organic sessions, and "insufficient data"
  // (not a number) until 21 days of clicks carry a traffic source.
  const [clicks, sessions] = await Promise.all([
    readOrganicConversionClicks(db, { since: stableStartDate, until: stableEndDate }),
    getOrganicSessions(env, fmt(stableStartDate), fmt(stableEndDate)),
  ]);
  const conversions = clicks.status === "ready" ? clicks.organicClicks : clicks.allClicks;
  const rate =
    clicks.status === "ready" && sessions != null && sessions > 0 ? conversions / sessions : null;
  return {
    conversions,
    sessions,
    rate,
    // OPE-1131 — a GA4 failure and an empty week both used to print "—".
    // A GA4 outage is still named first — it is the louder, fixable cause.
    rateMeasured:
      sessions == null
        ? unavailable("GA4 organic sessions unavailable")
        : clicks.status === "insufficient"
          ? unavailable(insufficientAttributionReason(clicks))
          : rateOf(conversions, sessions, "no organic sessions in window"),
    organicBasis: clicks.status === "ready",
    windowDays: days,
    windowEndDate: fmt(stableEndDate),
  };
}
