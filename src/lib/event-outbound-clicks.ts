/**
 * Per-event outbound-click aggregation.
 *
 * Analyst A5 (2026-05-29 backlog) — the first-party conversion stream is the
 * only place we can attribute "did this listing actually drive a click on
 * the ticket / vendor application URL?" GA4 has the page view but not the
 * outbound link (the destination is a third-party domain GA4 didn't sample).
 * Before this helper the data only existed as a chronological feed in
 * /admin/analytics → Activity, which makes per-event "is this listing
 * performing?" impossible to answer at a glance.
 *
 * Storage: `analytics_events` rows with eventName in
 * ('outbound_ticket_click', 'outbound_application_click'). The `properties`
 * JSON column carries `eventSlug` (set by the beacon at
 * src/lib/analytics.ts:trackOutboundTicketClick / trackOutboundApplicationClick)
 * and `destinationUrl`. We filter by slug via SQLite's json_extract so we
 * don't drag every conversion row into JS for one event's aggregate.
 *
 * Why slug, not eventId: the beacon fires from the public detail page
 * (/events/<slug>) and only has the slug. Slug-history rewrites would
 * cause undercounting on renamed events; that's a known limitation
 * pending a separate slug-rewrite pass at query time (out of scope).
 */
import { and, gte, inArray, lt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { analyticsEvents } from "@/lib/db/schema";

type Db = DrizzleD1Database<typeof schema>;

const OUTBOUND_EVENT_NAMES = ["outbound_ticket_click", "outbound_application_click"] as const;

export interface OutboundClicksForEvent {
  ticketClicks: number;
  applicationClicks: number;
  totalClicks: number;
  /** Top destination URLs by click count, capped at 10. Sorted desc. */
  topDestinations: Array<{ url: string; count: number }>;
  windowStartIso: string;
  windowEndIso: string;
}

/**
 * Count outbound clicks for a single event in [startDate, endDate). The
 * endDate is exclusive to match the page-analytics range semantics — same
 * day-resolution caller is using elsewhere on the analytics tab.
 */
export async function getOutboundClicksForEventSlug(
  db: Db,
  slug: string,
  startDate: Date,
  endDate: Date
): Promise<OutboundClicksForEvent> {
  const rows = await db
    .select({
      eventName: analyticsEvents.eventName,
      properties: analyticsEvents.properties,
    })
    .from(analyticsEvents)
    .where(
      and(
        inArray(analyticsEvents.eventName, [...OUTBOUND_EVENT_NAMES]),
        // json_extract on the SQLite side avoids dragging every
        // conversion row over the wire just to filter in JS. Index
        // assist: idx_analytics_events_name_ts narrows by eventName,
        // then json_extract is a per-row probe over that bucket — cheap
        // at the per-event volumes we see (<5k clicks/event/day).
        // json_valid() guard: malformed properties (unlikely from our
        // beacon path but defensive) make json_extract throw on the
        // whole query result; the guard short-circuits to false instead.
        sql`json_valid(${analyticsEvents.properties}) AND json_extract(${analyticsEvents.properties}, '$.eventSlug') = ${slug}`,
        gte(analyticsEvents.timestamp, startDate),
        lt(analyticsEvents.timestamp, endDate)
      )
    );

  let ticket = 0;
  let app = 0;
  const destinationCounts = new Map<string, number>();
  for (const r of rows) {
    if (r.eventName === "outbound_ticket_click") ticket++;
    else if (r.eventName === "outbound_application_click") app++;
    try {
      const props = JSON.parse(r.properties ?? "{}") as {
        destinationUrl?: string;
      };
      if (props.destinationUrl) {
        destinationCounts.set(
          props.destinationUrl,
          (destinationCounts.get(props.destinationUrl) ?? 0) + 1
        );
      }
    } catch {
      // Malformed properties shouldn't drop the row from the
      // event-name counts — only the destination breakdown.
    }
  }

  const topDestinations = [...destinationCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([url, count]) => ({ url, count }));

  return {
    ticketClicks: ticket,
    applicationClicks: app,
    totalClicks: ticket + app,
    topDestinations,
    windowStartIso: startDate.toISOString(),
    windowEndIso: endDate.toISOString(),
  };
}
