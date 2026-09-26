/**
 * OPE-1165 — the conversion-rate numerator on the SAME basis as its GA4
 * denominator (`sessionMedium = organic`).
 *
 * Until the click beacon has recorded a traffic source for at least
 * ATTRIBUTION_MIN_DAYS, a like-for-like rate cannot be computed for a full
 * window, and the card says so instead of printing a number (OPE-808 render
 * states). The KPI badge goes INDETERMINATE for the same period, which keeps it
 * out of the action queue — the same treatment an under-sampled Time-to-index
 * already gets.
 *
 * Both the badge (`kpi-states.ts`) and the card (`analytics-overview/
 * conversions.ts`) read through here, so they switch on the same day and can
 * never disagree about which basis is live.
 */
import { and, count, gte, inArray, lt, min, sql } from "drizzle-orm";
import { analyticsEvents } from "@/lib/db/schema";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "@/lib/db/schema";

type Db = DrizzleD1Database<typeof schema>;

/** Days of attributed clicks required before the organic rate is shown. */
export const ATTRIBUTION_MIN_DAYS = 21;
/** GA4's session medium for a search-engine visit (and what the beacon records). */
export const ORGANIC_MEDIUM = "organic";
/** The clicks that count as a conversion — ticket + application outbound. */
export const CONVERSION_CLICK_EVENTS = [
  "outbound_ticket_click",
  "outbound_application_click",
] as const;

const MEDIUM = sql`json_extract(${analyticsEvents.properties}, '$.trafficMedium')`;

export type OrganicClicksResult =
  | { status: "ready"; organicClicks: number; allClicks: number }
  | {
      status: "insufficient";
      allClicks: number;
      /** First click carrying a traffic source; null = none yet. */
      firstAttributedAt: Date | null;
      readyOn: Date | null;
    };

export async function readOrganicConversionClicks(
  db: Db,
  window: { since: Date; until: Date },
  now: Date = new Date()
): Promise<OrganicClicksResult> {
  const inWindow = and(
    inArray(analyticsEvents.eventName, [...CONVERSION_CLICK_EVENTS]),
    gte(analyticsEvents.timestamp, window.since),
    lt(analyticsEvents.timestamp, window.until)
  );
  const [[all], [first]] = await Promise.all([
    db.select({ n: count() }).from(analyticsEvents).where(inWindow),
    db
      .select({ at: min(analyticsEvents.timestamp) })
      .from(analyticsEvents)
      .where(
        and(
          inArray(analyticsEvents.eventName, [...CONVERSION_CLICK_EVENTS]),
          sql`${MEDIUM} IS NOT NULL`
        )
      ),
  ]);
  const allClicks = all?.n ?? 0;
  const firstAttributedAt = first?.at ?? null;
  const readyOn = firstAttributedAt
    ? new Date(firstAttributedAt.getTime() + ATTRIBUTION_MIN_DAYS * 86_400_000)
    : null;
  // Ready only when attribution covers the whole window AND the 21 days.
  if (!firstAttributedAt || !readyOn || readyOn > now || firstAttributedAt > window.since) {
    return { status: "insufficient", allClicks, firstAttributedAt, readyOn };
  }
  const [org] = await db
    .select({ n: count() })
    .from(analyticsEvents)
    .where(and(inWindow, sql`${MEDIUM} = ${ORGANIC_MEDIUM}`));
  return { status: "ready", organicClicks: org?.n ?? 0, allClicks };
}

/** The card's "insufficient data" reason, naming the day it switches over. */
export function insufficientAttributionReason(r: {
  firstAttributedAt: Date | null;
  readyOn: Date | null;
}): string {
  if (!r.firstAttributedAt || !r.readyOn) {
    return "no clicks carry a traffic source yet — organic ÷ organic starts 21 days after the first (OPE-1165)";
  }
  return `traffic source recorded on clicks since ${r.firstAttributedAt
    .toISOString()
    .slice(0, 10)}; organic ÷ organic from ${r.readyOn.toISOString().slice(0, 10)} (OPE-1165)`;
}
