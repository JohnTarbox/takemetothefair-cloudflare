/**
 * GW1b stale-page radar cron — emit `event_discrepancies` rows when
 * the stored canonical start_date drifts from a corroborating source's
 * fresh canonical date.
 *
 * **Input source: `event_date_drift_findings`** — pre-existing table
 * (drizzle/0070) populated by the daily event-date-drift workflow.
 * Each unresolved row already says "row X has drift_days N from the
 * source at canonicalUrl." We just lift each unresolved row into a
 * discrepancy with `detected_by='stale_page_radar'`.
 *
 * ## Why not crawl directly here
 *
 * The actual crawl logic lives in the event-date-drift workflow
 * (mcp-server/src/workflows/event-date-drift.ts) which runs on the
 * same `0 6 * * *` cron. By the time this radar fires (in the same
 * waitUntil block), the drift workflow has already produced fresh
 * `event_date_drift_findings` rows. We're not re-fetching anything —
 * just taking the workflow's outputs and emitting the structured
 * discrepancy rows that GW1c/d/e will consume.
 *
 * ## Cap and politeness
 *
 * Cap at 500 rows per run (per the dev-email plan and
 * [[feedback_cloudflare_30s_budget_for_browser_loops]]). The query is
 * a single SELECT with an existing index on `resolved_at IS NULL` so
 * 500 row reads + 500 indexed INSERTs (with the 24h captureDiscrepancy
 * dedupe check) fit easily inside CF's 30s budget.
 */

import { and, eq, isNull, desc, sql, ne } from "drizzle-orm";
import { eventDateDriftFindings, eventDiscrepancies, events, promoters } from "../schema.js";
import type { Db } from "../db.js";
import { captureStalePageDiscrepancy } from "./capture.js";
import { logError } from "../logger.js";

const MAX_PER_RUN = 500;

export interface StalePageRadarResult {
  scanned: number;
  emitted: number;
  skipped_dedup: number;
  /** OPE-815 — findings already adjudicated (a non-open row for the same fact). */
  skipped_adjudicated: number;
  /** OPE-815 — open radar rows closed because their event has finished. */
  closed_past: number;
}

/**
 * An event is past when its end (or, lacking one, its start) is before now.
 * ⚠️ A DATELESS event is not past: written as an explicit IS NOT NULL so the
 * NULL comparison cannot turn `NOT (…)` into NULL and silently drop the
 * finding (the OPE-815 rework's first draft did exactly that).
 */
const EVENT_IS_PAST = sql`(coalesce(${events.endDate}, ${events.startDate}) IS NOT NULL AND coalesce(${events.endDate}, ${events.startDate}) < unixepoch())`;

/**
 * Per [[feedback_drizzle_d1_unit_test_inject_db]] — accept `db: Db`
 * directly so unit tests can pass an in-memory better-sqlite3-backed
 * Db. The cron caller in `mcp-server/src/index.ts` wraps env.DB via
 * `getDb(env.DB)` at the call site.
 */
export async function runScheduledStalePageRadar(db: Db): Promise<StalePageRadarResult> {
  const SOURCE = "mcp:schedule:stale-page-radar";
  const result: StalePageRadarResult = {
    scanned: 0,
    emitted: 0,
    skipped_dedup: 0,
    skipped_adjudicated: 0,
    closed_past: 0,
  };

  try {
    // OPE-815 (09-23 bounce) — a finished event's date drift is history, not
    // a live conflict. The radar re-stamped the four past Truro occurrences
    // every morning; close their open rows with the lifecycle vocabulary
    // OPE-306 already uses for exactly this.
    const pastOpen = await db
      .select({ id: eventDiscrepancies.id })
      .from(eventDiscrepancies)
      .innerJoin(events, eq(events.id, eventDiscrepancies.eventId))
      .where(
        and(
          eq(eventDiscrepancies.detectedBy, "stale_page_radar"),
          eq(eventDiscrepancies.resolutionStatus, "open"),
          EVENT_IS_PAST
        )
      );
    for (const r of pastOpen) {
      await db
        .update(eventDiscrepancies)
        .set({
          resolutionStatus: "superseded_by_lifecycle",
          resolutionSource: "post_event",
          resolvedAt: new Date(),
        })
        .where(eq(eventDiscrepancies.id, r.id));
    }
    result.closed_past = pastOpen.length;

    // Pull unresolved drift findings, newest first. Limit to MAX_PER_RUN
    // so a backlog of historical drifts doesn't blow the CF response
    // budget on the first cron after the radar lands.
    const findings = await db
      .select({
        id: eventDateDriftFindings.id,
        eventId: eventDateDriftFindings.eventId,
        storedStartDate: eventDateDriftFindings.storedStartDate,
        canonicalStartDate: eventDateDriftFindings.canonicalStartDate,
        canonicalUrl: eventDateDriftFindings.canonicalUrl,
        driftDays: eventDateDriftFindings.driftDays,
        checkedAt: eventDateDriftFindings.checkedAt,
        // OPE-815 — the promoter's own site, so the comparison target can be
        // classified organizer vs aggregator. LEFT joins: an event with no
        // promoter, or a promoter with no website, yields NULL and the target
        // classifies as `unknown` — which is never treated as organizer.
        promoterWebsite: promoters.website,
      })
      .from(eventDateDriftFindings)
      .leftJoin(events, eq(events.id, eventDateDriftFindings.eventId))
      .leftJoin(promoters, eq(promoters.id, events.promoterId))
      .where(
        and(
          isNull(eventDateDriftFindings.resolvedAt),
          // 0 drift is uninteresting; skip in SQL so we don't burn an INSERT slot.
          sql`abs(${eventDateDriftFindings.driftDays}) > 0`,
          // OPE-815 — never lift a finding for a finished event.
          sql`NOT (${EVENT_IS_PAST})`
        )
      )
      .orderBy(desc(eventDateDriftFindings.checkedAt))
      .limit(MAX_PER_RUN);

    result.scanned = findings.length;

    for (const f of findings) {
      // OPE-815 (09-23 bounce) — the finding table is never resolved when its
      // DISCREPANCY is, so the morning after an operator closed a row the radar
      // lifted the same finding into a fresh one (Jenks a3f3f653 closed 22:03,
      // re-opened as ecd88d5e at 06:02). A non-open row for the same event,
      // source and divergent date means this fact was already adjudicated.
      const divergent = f.canonicalStartDate?.toISOString().slice(0, 10) ?? null;
      const [adjudicated] = await db
        .select({ id: eventDiscrepancies.id })
        .from(eventDiscrepancies)
        .where(
          and(
            eq(eventDiscrepancies.eventId, f.eventId),
            eq(eventDiscrepancies.detectedBy, "stale_page_radar"),
            ne(eventDiscrepancies.resolutionStatus, "open"),
            divergent === null
              ? isNull(eventDiscrepancies.divergentValue)
              : eq(eventDiscrepancies.divergentValue, divergent),
            f.canonicalUrl === null
              ? isNull(eventDiscrepancies.divergentSourceUrl)
              : eq(eventDiscrepancies.divergentSourceUrl, f.canonicalUrl)
          )
        )
        .limit(1);
      if (adjudicated) {
        result.skipped_adjudicated += 1;
        continue;
      }
      const id = await captureStalePageDiscrepancy(db, {
        eventId: f.eventId,
        storedStartDate: f.storedStartDate,
        canonicalStartDate: f.canonicalStartDate,
        canonicalUrl: f.canonicalUrl,
        driftDays: f.driftDays,
        promoterWebsite: f.promoterWebsite,
      });
      if (id) {
        result.emitted += 1;
      } else {
        result.skipped_dedup += 1;
      }
    }

    console.log(`[cron] stale-page-radar ok — ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    await logError(db, {
      source: SOURCE,
      message: "stale-page-radar threw unhandled exception",
      error,
    });
    return result;
  }
}
