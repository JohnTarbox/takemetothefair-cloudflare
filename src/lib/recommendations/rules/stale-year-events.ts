/**
 * APPROVED events whose end_date is in the past — typically annual recurring
 * fairs whose start/end dates haven't been refreshed to the current year yet.
 * Surfaced so the admin can either bump the dates (one-time UPDATE) or set
 * status to a non-APPROVED value (CANCELLED, etc.) to keep them off public
 * pages.
 *
 * Note: project_public_events_are_past memory documents that
 * isPublicEventStatus() has no date filter, so as of 2026-04-21 the prod
 * APPROVED set was entirely past events. This rule turns that situation into
 * actionable items rather than a silent backlog.
 */

import { and, eq, lt } from "drizzle-orm";
import { events } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

export const staleYearEventsRule: RuleDefinition = {
  ruleKey: "stale_year_events",
  title: "APPROVED events with past end dates",
  rationaleTemplate:
    "{n} APPROVED events have already ended. Update their dates to the next instance, or change their status to CANCELLED so they leave public pages.",
  severity: "yellow",
  category: "data_quality",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    const now = new Date();
    const rows = await db
      .select({
        id: events.id,
        name: events.name,
        slug: events.slug,
        startDate: events.startDate,
        endDate: events.endDate,
      })
      .from(events)
      .where(and(eq(events.status, "APPROVED"), lt(events.endDate, now)));

    return rows.map((r) => ({
      targetType: "event",
      targetId: r.id,
      payload: {
        name: r.name,
        slug: r.slug,
        endedOn: r.endDate ? r.endDate.toISOString().slice(0, 10) : null,
        startedOn: r.startDate ? r.startDate.toISOString().slice(0, 10) : null,
      },
    }));
  },
};
