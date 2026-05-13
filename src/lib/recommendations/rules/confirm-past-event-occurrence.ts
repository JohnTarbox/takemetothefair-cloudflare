/**
 * Past-event occurrence audit. The migration 0067 backfill auto-tagged
 * APPROVED events whose end_date had passed as lifecycle = OCCURRED — the
 * conservative interpretation (promoter who left their listing APPROVED is
 * assumed to have held the event). This rule surfaces those events so an
 * admin can either:
 *
 *   - Confirm OCCURRED via the lifecycle dropdown (any lifecycle change
 *     writes an admin_actions row, which satisfies the NOT EXISTS clause
 *     below and drops the item from this rule's active list)
 *   - Flip to NO_SHOW for events the admin knows didn't actually happen
 *
 * Window: events that ended in the past 7-30 days. Sub-7-day window is too
 * fresh (admin hasn't had a chance to learn outcome); >30 days is too stale
 * to triage usefully.
 *
 * Volume in prod (2026-05-13): 203 events tagged OCCURRED by the backfill,
 * but most ended >30 days ago and won't surface here. Roughly the last
 * month of events at any given time — small enough to triage manually.
 */

import { and, eq, gt, lt, sql } from "drizzle-orm";
import { events } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const confirmPastEventOccurrenceRule: RuleDefinition = {
  ruleKey: "confirm_past_event_occurrence",
  title: "Confirm past-event occurrence (auto-tagged OCCURRED)",
  rationaleTemplate:
    "{n} events ended in the past 1-4 weeks and are tagged OCCURRED by default. Confirm they happened (or flip to NO_SHOW) so the past-event SEO content is accurate.",
  severity: "blue",
  category: "data_quality",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    const now = new Date();
    const upperBound = new Date(now.getTime() - SEVEN_DAYS_MS);
    const lowerBound = new Date(now.getTime() - THIRTY_DAYS_MS);

    // NOT EXISTS on admin_actions resolves to "no admin has touched this
    // event's lifecycle yet" — i.e. it's still on the auto-backfill default.
    // Once any lifecycle_change row exists for the event, it drops out.
    const rows = await db
      .select({
        id: events.id,
        name: events.name,
        slug: events.slug,
        endDate: events.endDate,
      })
      .from(events)
      .where(
        and(
          eq(events.status, "APPROVED"),
          eq(events.lifecycleStatus, "OCCURRED"),
          lt(events.endDate, upperBound),
          gt(events.endDate, lowerBound),
          sql`NOT EXISTS (
            SELECT 1 FROM admin_actions
            WHERE admin_actions.action = 'event.lifecycle_change'
              AND admin_actions.target_id = ${events.id}
          )`
        )
      );

    return rows.map((r) => ({
      targetType: "event",
      targetId: r.id,
      payload: {
        name: r.name,
        slug: r.slug,
        endedOn: r.endDate ? r.endDate.toISOString().slice(0, 10) : null,
      },
    }));
  },
};
