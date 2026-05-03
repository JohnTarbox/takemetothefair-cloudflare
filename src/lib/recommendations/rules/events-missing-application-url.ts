/**
 * APPROVED upcoming events with no application_url, ranked by recent traffic
 * (view_event_detail clicks in the last 30 days). Surfaces the highest-leverage
 * conversion gap: vendors who'd want to apply but have nowhere to click.
 */

import { and, eq, gt, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { analyticsEvents, events } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

const RESULT_LIMIT = 25;
const TRAFFIC_LOOKBACK_DAYS = 30;

export const eventsMissingApplicationUrlRule: RuleDefinition = {
  ruleKey: "events_missing_application_url",
  title: "Top-traffic upcoming events have no application URL",
  rationaleTemplate:
    "{n} APPROVED upcoming events with traffic have no vendor application URL. Vendors interested have nowhere to click.",
  severity: "yellow",
  category: "conversion",
  async run(db): Promise<ItemMatch[]> {
    // Step 1: aggregate event slugs by view count over the last 30d.
    // analyticsEvents.timestamp is raw INTEGER seconds (per migration 0035).
    const sinceDate = new Date(Date.now() - TRAFFIC_LOOKBACK_DAYS * 86400 * 1000);
    const trafficRows = await db
      .select({
        slug: sql<string>`json_extract(${analyticsEvents.properties}, '$.eventSlug')`,
        views: sql<number>`COUNT(*)`,
      })
      .from(analyticsEvents)
      .where(
        and(
          eq(analyticsEvents.eventName, "view_event_detail"),
          gte(analyticsEvents.timestamp, sinceDate)
        )
      )
      .groupBy(sql`json_extract(${analyticsEvents.properties}, '$.eventSlug')`);

    const viewsBySlug = new Map<string, number>();
    for (const r of trafficRows) {
      if (r.slug) viewsBySlug.set(r.slug, r.views);
    }

    // Step 2: fetch APPROVED upcoming events with no application_url.
    const candidates = await db
      .select({
        id: events.id,
        name: events.name,
        slug: events.slug,
        startDate: events.startDate,
      })
      .from(events)
      .where(
        and(
          eq(events.status, "APPROVED"),
          gt(events.startDate, new Date()),
          or(isNull(events.applicationUrl), eq(events.applicationUrl, ""))
        )
      );

    // Step 3: rank by traffic, take top N.
    const ranked = candidates
      .map((c) => ({ ...c, views: viewsBySlug.get(c.slug) ?? 0 }))
      .sort((a, b) => b.views - a.views)
      .slice(0, RESULT_LIMIT);

    return ranked.map((c) => ({
      targetType: "event",
      targetId: c.id,
      payload: {
        name: c.name,
        slug: c.slug,
        views30d: c.views,
        startDate: c.startDate ? c.startDate.toISOString() : null,
      },
    }));

    void inArray;
  },
};
