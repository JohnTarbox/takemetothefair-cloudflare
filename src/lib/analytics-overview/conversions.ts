/**
 * Conversion domain loaders: the row-1 Conversions delta, the 30-day
 * conversions sparkline, and the §6.3 conversion-rate card.
 */

import { and, count, gte, inArray, lt, sql } from "drizzle-orm";
import { analyticsEvents } from "@/lib/db/schema";
import { getOrganicSessions, type Ga4Env } from "@/lib/ga4";
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
  const [currentRows, priorRows] = await Promise.all([
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
  ]);
  const current = currentRows[0]?.c ?? 0;
  const previous = priorRows[0]?.c ?? 0;
  return {
    current,
    previous,
    trend: trendOf(current, previous),
    windowDays: days,
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

  const [numRow, sessions] = await Promise.all([
    db
      .select({ n: count() })
      .from(analyticsEvents)
      .where(
        and(
          inArray(analyticsEvents.eventName, [...CONVERSION_EVENT_NAMES]),
          gte(analyticsEvents.timestamp, stableStartDate),
          lt(analyticsEvents.timestamp, stableEndDate)
        )
      ),
    getOrganicSessions(env, fmt(stableStartDate), fmt(stableEndDate)),
  ]);
  const conversions = numRow[0]?.n ?? 0;
  const rate = sessions != null && sessions > 0 ? conversions / sessions : null;
  return {
    conversions,
    sessions,
    rate,
    windowDays: days,
    windowEndDate: fmt(stableEndDate),
  };
}
