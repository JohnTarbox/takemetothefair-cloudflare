/**
 * Surfaces unresolved drift findings from the daily re-verification cron.
 * Each row in event_date_drift_findings WHERE resolved_at IS NULL becomes
 * a recommendation item. Admin "Accept canonical" action will fire the
 * lifecycle PATCH endpoint (or a future dedicated drift-resolve route)
 * which sets events.start_date/end_date and updates resolved_at.
 *
 * Tier T2 — SEO defense (wrong dates surface in JSON-LD + GSC, which
 * is exactly the contradicts-our-brand-promise issue the analyst flagged
 * 2026-05-16). Severity yellow; CANCELLATIONS would be red, but a single-
 * day date drift is recoverable through admin action.
 */

import { and, eq, isNull } from "drizzle-orm";
import { eventDateDriftFindings, events } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

export const eventDateDriftRule: RuleDefinition = {
  ruleKey: "event_date_drift",
  title: "Stored event dates drift from canonical source",
  rationaleTemplate:
    "{n} APPROVED upcoming events have stored start dates that disagree with their source URL by more than 1 day. Verify against the source and accept canonical (or correct the stored value) so JSON-LD + sitemap dates match reality.",
  severity: "yellow",
  category: "seo_defense",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    const rows = await db
      .select({
        findingId: eventDateDriftFindings.id,
        eventId: eventDateDriftFindings.eventId,
        storedStartDate: eventDateDriftFindings.storedStartDate,
        canonicalStartDate: eventDateDriftFindings.canonicalStartDate,
        driftDays: eventDateDriftFindings.driftDays,
        canonicalUrl: eventDateDriftFindings.canonicalUrl,
        eventName: events.name,
        eventSlug: events.slug,
      })
      .from(eventDateDriftFindings)
      .innerJoin(events, eq(eventDateDriftFindings.eventId, events.id))
      .where(and(isNull(eventDateDriftFindings.resolvedAt), eq(events.status, "APPROVED")));

    return rows.map((r) => ({
      targetType: "event",
      targetId: r.eventId,
      payload: {
        name: r.eventName,
        slug: r.eventSlug,
        finding_id: r.findingId,
        stored_start_date: r.storedStartDate?.toISOString() ?? null,
        canonical_start_date: r.canonicalStartDate?.toISOString() ?? null,
        drift_days: r.driftDays,
        canonical_url: r.canonicalUrl,
      },
    }));
  },
};
