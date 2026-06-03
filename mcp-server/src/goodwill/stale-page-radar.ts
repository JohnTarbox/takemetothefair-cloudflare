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

import { and, isNull, desc, sql } from "drizzle-orm";
import { eventDateDriftFindings } from "../schema.js";
import type { Db } from "../db.js";
import { captureStalePageDiscrepancy } from "./capture.js";
import { logError } from "../logger.js";

const MAX_PER_RUN = 500;

export interface StalePageRadarResult {
  scanned: number;
  emitted: number;
  skipped_dedup: number;
}

/**
 * Per [[feedback_drizzle_d1_unit_test_inject_db]] — accept `db: Db`
 * directly so unit tests can pass an in-memory better-sqlite3-backed
 * Db. The cron caller in `mcp-server/src/index.ts` wraps env.DB via
 * `getDb(env.DB)` at the call site.
 */
export async function runScheduledStalePageRadar(db: Db): Promise<StalePageRadarResult> {
  const SOURCE = "mcp:schedule:stale-page-radar";
  const result: StalePageRadarResult = { scanned: 0, emitted: 0, skipped_dedup: 0 };

  try {
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
      })
      .from(eventDateDriftFindings)
      .where(
        and(
          isNull(eventDateDriftFindings.resolvedAt),
          // 0 drift is uninteresting; skip in SQL so we don't burn an INSERT slot.
          sql`abs(${eventDateDriftFindings.driftDays}) > 0`
        )
      )
      .orderBy(desc(eventDateDriftFindings.checkedAt))
      .limit(MAX_PER_RUN);

    result.scanned = findings.length;

    for (const f of findings) {
      const id = await captureStalePageDiscrepancy(db, {
        eventId: f.eventId,
        storedStartDate: f.storedStartDate,
        canonicalStartDate: f.canonicalStartDate,
        canonicalUrl: f.canonicalUrl,
        driftDays: f.driftDays,
      });
      if (id) {
        result.emitted += 1;
      } else {
        result.skipped_dedup += 1;
      }
    }

    console.log(
      `[cron] stale-page-radar ok — scanned=${result.scanned} emitted=${result.emitted} skipped_dedup=${result.skipped_dedup}`
    );
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
