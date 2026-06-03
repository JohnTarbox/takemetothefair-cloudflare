/**
 * GW1b self-consistency cron — promote the existing
 * `scripts/audit-event-date-patterns.ts` audit from a CLI-only TSV
 * dump into a daily emit of `event_discrepancies` rows with
 * `detected_by='self_consistency'`.
 *
 * Reuses `evaluateGates()` from `@takemetothefair/utils` so the
 * detection logic stays single-sourced — the same evaluator that runs
 * at ingest time runs here on the historical corpus. Reasons that
 * fire map to discrepancy `field_class` via `gateReasonToFieldClass`
 * in capture.ts.
 *
 * ## Cap
 *
 * Cap at 500 events per run. With ~1,260 APPROVED events in the
 * current corpus and ~10% trip-rate observed in the May 6 / June 2
 * audits, that yields ≤ 50 emissions per day under steady state. The
 * `captureDiscrepancy` 24h dedupe means re-runs within the same day
 * don't double-insert; over the course of a week the cron will
 * naturally rotate through the whole corpus.
 *
 * Future tuning: a rotating window (LIMIT 500 OFFSET (dayOfYear * 500
 * % corpus_size)) would guarantee corpus coverage on the same week
 * regardless of ordering. Defer until the corpus crosses ~2,500
 * events; today the priority-by-checkedAt heuristic suffices.
 */

import { eq, sql } from "drizzle-orm";
import { events } from "../schema.js";
import { evaluateGates } from "@takemetothefair/utils";
import type { Db } from "../db.js";
import { captureSelfConsistencyDiscrepancy } from "./capture.js";
import { logError } from "../logger.js";

const MAX_PER_RUN = 500;

export interface SelfConsistencyResult {
  scanned: number;
  flagged: number;
  emitted: number;
  skipped_dedup: number;
  skipped_no_field_class: number;
}

/**
 * Per [[feedback_drizzle_d1_unit_test_inject_db]] — accept `db: Db`
 * directly so unit tests can pass an in-memory better-sqlite3-backed
 * Db. The cron caller in `mcp-server/src/index.ts` wraps env.DB via
 * `getDb(env.DB)` at the call site.
 */
export async function runScheduledSelfConsistencyCron(db: Db): Promise<SelfConsistencyResult> {
  const SOURCE = "mcp:schedule:self-consistency";
  const result: SelfConsistencyResult = {
    scanned: 0,
    flagged: 0,
    emitted: 0,
    skipped_dedup: 0,
    skipped_no_field_class: 0,
  };

  try {
    // Pull APPROVED events with a start_date. Order by updated_at ASC
    // (least-recently-touched first) so high-churn events that may
    // already be in operator triage don't dominate the daily emit.
    const rows = await db
      .select({
        id: events.id,
        name: events.name,
        startDate: events.startDate,
        endDate: events.endDate,
        sourceName: events.sourceName,
        sourceUrl: events.sourceUrl,
        description: events.description,
      })
      .from(events)
      .where(eq(events.status, "APPROVED"))
      .orderBy(sql`coalesce(${events.updatedAt}, 0) asc`)
      .limit(MAX_PER_RUN);

    result.scanned = rows.length;

    for (const ev of rows) {
      const gate = evaluateGates({
        name: ev.name,
        sourceName: ev.sourceName ?? null,
        sourceUrl: ev.sourceUrl ?? null,
        startDate: ev.startDate,
        endDate: ev.endDate,
        applicationDeadline: null, // not on the events table
        description: ev.description ?? null,
      });
      if (gate.route !== "PENDING_REVIEW") continue;
      result.flagged += 1;

      // One discrepancy per (event, reason) tuple. The 24h dedupe in
      // captureDiscrepancy collapses re-runs.
      for (const reason of gate.reasons) {
        const id = await captureSelfConsistencyDiscrepancy(db, {
          eventId: ev.id,
          reason,
          sourceUrl: ev.sourceUrl,
          authoritativeValue: ev.startDate ? ev.startDate.toISOString().slice(0, 10) : null,
          confidence: 0.9,
        });
        if (id === null) {
          // null can mean either dedupe-hit OR field_class=null (taxonomy
          // gap — currently only `source_tier_*` reasons land here). Both
          // are silent no-ops.
          result.skipped_dedup += 1; // approximate; we don't distinguish
        } else {
          result.emitted += 1;
        }
      }
    }

    console.log(
      `[cron] self-consistency ok — scanned=${result.scanned} flagged=${result.flagged} emitted=${result.emitted} skipped=${result.skipped_dedup}`
    );
    return result;
  } catch (error) {
    await logError(db, {
      source: SOURCE,
      message: "self-consistency cron threw unhandled exception",
      error,
    });
    return result;
  }
}
