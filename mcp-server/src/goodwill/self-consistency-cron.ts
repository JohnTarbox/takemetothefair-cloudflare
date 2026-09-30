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

import { and, eq, inArray, sql } from "drizzle-orm";
import { events, eventDiscrepancies } from "../schema.js";
import { chunkIds, evaluateGates } from "@takemetothefair/utils";
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
  /** OPE-1032 — open rows closed because re-evaluation no longer fires their reason. */
  superseded: number;
}

/**
 * OPE-1032 — the bookkeeping status for "the gate no longer fires on this row".
 * A SUPERSEDED status, not `self_resolved`: re-evaluation under a retuned gate
 * says nothing about whether the data matched the truth, so it must not feed the
 * reliability learner (scoring skips every status except the resolved ones).
 */
export const SUPERSEDED_BY_REEVALUATION = "superseded_by_reevaluation";

/** Reasons closed by their own owner, never by re-evaluation here (OPE-306). */
const REEVALUATION_EXCLUDED_REASONS: ReadonlySet<string> = new Set(["end_date_in_past"]);

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
    superseded: 0,
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
        // OPE-1032 — without these the gate's existing MAJOR / recurring-series
        // exemptions could never apply here, and season-long rows re-filed daily.
        eventScale: events.eventScale,
        discontinuousDates: events.discontinuousDates,
        categories: events.categories,
        eventDaysCount: sql<number>`(SELECT COUNT(*) FROM event_days WHERE event_days.event_id = ${events.id})`,
      })
      .from(events)
      .where(eq(events.status, "APPROVED"))
      .orderBy(sql`coalesce(${events.updatedAt}, 0) asc`)
      .limit(MAX_PER_RUN);

    result.scanned = rows.length;

    // OPE-1032 — the open self_consistency rows for this batch, loaded once
    // (chunked under D1's bound-param cap) so re-evaluation can close the ones
    // whose reason no longer fires. Without this, a retuned gate or a corrected
    // event left its row open forever and the weekly drain re-adjudicated it.
    const openByEvent = new Map<string, { id: string; reason: string | null }[]>();
    for (const batch of chunkIds(rows.map((r) => r.id))) {
      const open = await db
        .select({
          id: eventDiscrepancies.id,
          eventId: eventDiscrepancies.eventId,
          reason: eventDiscrepancies.divergentValue,
        })
        .from(eventDiscrepancies)
        .where(
          and(
            inArray(eventDiscrepancies.eventId, batch),
            eq(eventDiscrepancies.detectedBy, "self_consistency"),
            eq(eventDiscrepancies.resolutionStatus, "open")
          )
        );
      for (const o of open) {
        const list = openByEvent.get(o.eventId) ?? [];
        list.push({ id: o.id, reason: o.reason });
        openByEvent.set(o.eventId, list);
      }
    }
    const toSupersede: string[] = [];

    for (const ev of rows) {
      const gate = evaluateGates({
        name: ev.name,
        sourceName: ev.sourceName ?? null,
        sourceUrl: ev.sourceUrl ?? null,
        startDate: ev.startDate,
        endDate: ev.endDate,
        applicationDeadline: null, // not on the events table
        description: ev.description ?? null,
        eventScale: ev.eventScale ?? null,
        discontinuousDates: ev.discontinuousDates ?? null,
        eventDaysCount: Number(ev.eventDaysCount ?? 0),
        categories: ev.categories ?? null,
      });
      for (const o of openByEvent.get(ev.id) ?? []) {
        if (
          o.reason &&
          !REEVALUATION_EXCLUDED_REASONS.has(o.reason) &&
          !gate.reasons.includes(o.reason)
        ) {
          toSupersede.push(o.id);
        }
      }
      if (gate.route !== "PENDING_REVIEW") continue;
      result.flagged += 1;

      // One discrepancy per (event, reason) tuple. The 24h dedupe in
      // captureDiscrepancy collapses re-runs.
      for (const reason of gate.reasons) {
        const id = await captureSelfConsistencyDiscrepancy(db, {
          eventId: ev.id,
          reason,
          sourceUrl: ev.sourceUrl,
          // OPE-1032 — a NAME reason is about the name, so an adjudication
          // stays valid until the name changes (see captureSelfConsistencyDiscrepancy).
          authoritativeValue: reason.startsWith("name_")
            ? ev.name
            : ev.startDate
              ? ev.startDate.toISOString().slice(0, 10)
              : null,
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

    for (const batch of chunkIds(toSupersede)) {
      await db
        .update(eventDiscrepancies)
        .set({
          resolutionStatus: SUPERSEDED_BY_REEVALUATION,
          resolvedAt: new Date(),
          notes: sql`COALESCE(${eventDiscrepancies.notes}, '') || ' | OPE-1032: gate no longer fires on re-evaluation'`,
        })
        .where(
          and(
            inArray(eventDiscrepancies.id, batch),
            eq(eventDiscrepancies.resolutionStatus, "open")
          )
        );
    }
    result.superseded = toSupersede.length;

    console.log(
      `[cron] self-consistency ok — scanned=${result.scanned} flagged=${result.flagged} emitted=${result.emitted} skipped=${result.skipped_dedup} superseded=${result.superseded}`
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
