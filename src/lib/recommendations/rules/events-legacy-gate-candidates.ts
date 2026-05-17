/**
 * Retroactive scanner: surfaces APPROVED events that would NOW trip the
 * pre-ingest gates if they were re-ingested today. These are events that
 * pre-date the gates shipping in 2026-05-16 (PRs #165–#168) plus any whose
 * data has changed since approval (admin edited the name to include "CALL
 * FOR", a date got changed to coincide with the application deadline, etc.).
 *
 * Mirrors the logic of scripts/audit-event-date-patterns.ts but as a live
 * admin-recommendations card instead of a one-off TSV dump.
 *
 * Tier T2 — SEO defense. Severity yellow because these are already public
 * (status=APPROVED) and visible in sitemap + JSON-LD; recoverable through
 * admin edit but lower urgency than PENDING events (which can be gate-
 * flagged today) because the bad data is already out there. event_date_drift
 * (also T2 yellow) is the analogous sibling for canonical-source drift.
 *
 * Performance note: this rule replays evaluateGates() in JS over the full
 * APPROVED event set. At ~2k APPROVED events the scan is well under a second
 * because evaluateGates is pure-JS with no I/O. If the APPROVED set grows
 * to >10k, consider a SQL pre-filter (Tier 3 source hosts via LIKE, or
 * name GLOB '*CALL FOR*') before the replay.
 */

import { and, eq, isNotNull } from "drizzle-orm";
import { events } from "@/lib/db/schema";
import { evaluateGates } from "@/lib/event-date-gates";
import type { ItemMatch, RuleDefinition } from "../engine";

export const eventsLegacyGateCandidatesRule: RuleDefinition = {
  ruleKey: "events_legacy_gate_candidates",
  title: "APPROVED events that would now trip the pre-ingest gates",
  rationaleTemplate:
    "{n} APPROVED events would route to PENDING_REVIEW if re-ingested today. These pre-date the 2026-05-16 gate rollout or have drifted since approval. Each may have a wrong date, sub-page name, or untrusted source — verify and correct (or REJECT if not actually an event).",
  severity: "yellow",
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
        applicationDeadline: events.applicationDeadline,
        description: events.description,
      })
      .from(events)
      .where(and(eq(events.status, "APPROVED"), isNotNull(events.startDate)));

    const matches: ItemMatch[] = [];
    for (const r of rows) {
      const result = evaluateGates({
        name: r.name,
        sourceUrl: r.sourceUrl,
        sourceName: r.sourceName,
        startDate: r.startDate,
        endDate: r.endDate,
        applicationDeadline: r.applicationDeadline,
        description: r.description,
      });
      if (result.route !== "PENDING_REVIEW") continue;
      matches.push({
        targetType: "event",
        targetId: r.id,
        payload: {
          name: r.name,
          slug: r.slug,
          source_url: r.sourceUrl,
          source_name: r.sourceName,
          stored_start_date: r.startDate?.toISOString() ?? null,
          stored_end_date: r.endDate?.toISOString() ?? null,
          would_flag_reasons: result.reasons,
          source_tier: result.tier,
        },
      });
    }
    return matches;
  },
};
