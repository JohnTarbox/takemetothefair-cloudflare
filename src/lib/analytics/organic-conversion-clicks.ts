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

/**
 * OPE-1658 (John, 2026-11-16) — the "Official Event Website" fallback button
 * (PR #1471, OPE-265) logs `outbound_ticket_click` with ctaSource=source_url.
 * Those clicks are a click-through to the organizer's page, not a ticket or
 * application conversion: by 11-14 they were ~85% of the numerator and had
 * turned the badge GREEN on a changed definition. They are counted separately
 * as `officialSiteClicks` (the official_site_click_rate tile) and excluded
 * from the conversion numerator. Pre-10-01 clicks carry no ctaSource and
 * count as conversions, which is the definition they were recorded under.
 * COALESCE keeps a NULL ctaSource from making the predicate NULL.
 */
const IS_OFFICIAL_SITE_CLICK = sql`(${analyticsEvents.eventName} = 'outbound_ticket_click' AND COALESCE(json_extract(${analyticsEvents.properties}, '$.ctaSource'), '') = 'source_url')`;

export type OrganicClicksResult =
  | {
      status: "ready";
      /** Ticket + application clicks (the conversion numerator). */
      organicClicks: number;
      /** OPE-1658 — organic "Official Event Website" fallback clicks. */
      officialSiteClicks: number;
      allClicks: number;
    }
  | {
      status: "insufficient";
      /** Ticket + application clicks from every source (fallback clicks excluded). */
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
    db
      .select({ n: count() })
      .from(analyticsEvents)
      .where(and(inWindow, sql`NOT ${IS_OFFICIAL_SITE_CLICK}`)),
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
    .select({
      conversion: sql<number>`COALESCE(SUM(CASE WHEN ${IS_OFFICIAL_SITE_CLICK} THEN 0 ELSE 1 END), 0)`,
      officialSite: sql<number>`COALESCE(SUM(CASE WHEN ${IS_OFFICIAL_SITE_CLICK} THEN 1 ELSE 0 END), 0)`,
    })
    .from(analyticsEvents)
    .where(and(inWindow, sql`${MEDIUM} = ${ORGANIC_MEDIUM}`));
  return {
    status: "ready",
    organicClicks: Number(org?.conversion ?? 0),
    officialSiteClicks: Number(org?.officialSite ?? 0),
    allClicks,
  };
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
