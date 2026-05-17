/**
 * Surfaces events that the pre-ingest gates routed to PENDING_REVIEW. Each
 * row in events WHERE status = 'PENDING' AND gate_flags IS NOT NULL becomes
 * a recommendation item, sorted by start_date ASC so the soonest-upcoming
 * triage targets surface first.
 *
 * Companion to event_date_drift: that rule catches APPROVED events whose
 * dates have drifted from the canonical source; this one catches events
 * the gates flagged at ingest time and which admin hasn't yet reviewed.
 *
 * Tier T2 — SEO defense (wrong dates / sub-page contamination would surface
 * in JSON-LD + sitemap if these were approved as-is). Severity red because
 * unlike event_date_drift, these events have NOT yet been published — admin
 * action gates whether they reach users at all.
 *
 * Clearing logic: see src/app/api/admin/events/[id]/route.ts — when admin
 * transitions status away from PENDING, gate_flags is nulled out. That
 * removes the row from this rule's match set on the next scan, and the
 * engine's autoResolve drops the corresponding recommendation item.
 */

import { and, asc, eq, isNotNull, ne } from "drizzle-orm";
import { events } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

/** Parse a gate_flags JSON string into a reason array. Defensive against
 *  malformed JSON (returns an `unparseable_gate_flags` placeholder rather
 *  than dropping the row) and non-array shapes (returns []). Exported for
 *  unit tests. */
export function parseGateFlags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return ["unparseable_gate_flags"];
  }
}

export const eventsPendingReviewRule: RuleDefinition = {
  ruleKey: "events_pending_review",
  title: "Events flagged by pre-ingest gates and awaiting admin review",
  rationaleTemplate:
    "{n} events were routed to PENDING by the date-quality gates (Tier 3 source, name patterns like 'CALL FOR', date plausibility checks). Verify against the source URL, correct any wrong fields, then promote to APPROVED — or REJECT if the listing isn't actually an event.",
  severity: "red",
  category: "seo_defense",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    const rows = await db
      .select({
        id: events.id,
        name: events.name,
        slug: events.slug,
        sourceUrl: events.sourceUrl,
        sourceName: events.sourceName,
        startDate: events.startDate,
        endDate: events.endDate,
        gateFlags: events.gateFlags,
      })
      .from(events)
      .where(
        and(
          eq(events.status, "PENDING"),
          isNotNull(events.gateFlags),
          // Empty-array sentinel — a JSON.stringify([]) write produces "[]"
          // which is truthy-and-not-null but represents "no flags fired".
          ne(events.gateFlags, "[]")
        )
      )
      .orderBy(asc(events.startDate));

    return rows.map((r) => ({
      targetType: "event",
      targetId: r.id,
      payload: {
        name: r.name,
        slug: r.slug,
        source_url: r.sourceUrl,
        source_name: r.sourceName,
        stored_start_date: r.startDate?.toISOString() ?? null,
        stored_end_date: r.endDate?.toISOString() ?? null,
        reasons: parseGateFlags(r.gateFlags),
      },
    }));
  },
};
