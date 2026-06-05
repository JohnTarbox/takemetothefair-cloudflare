/**
 * D — UR1 Phase 2 web-form correlation at intake (Dev backlog 2026-06-05).
 *
 * Extracted from `mcp-server/src/tools/admin-problem-reports.ts`'s
 * `correlate_problem_report` MCP tool so two surfaces can call the same
 * code:
 *
 *   1. The existing `correlate_problem_report` MCP tool (operator-side
 *      re-correlation for late-arriving error_logs entries).
 *   2. The new internal HTTP endpoint
 *      `POST /api/admin/internal/correlate-problem-report` invoked by
 *      the main-app web-form path
 *      (src/app/api/report-problem/route.ts) right after its insert.
 *
 * Pre-D, the web form inserted with severity=LOW and never correlated
 * at intake. Operators had to re-run the MCP tool manually whenever
 * the user-reported timing coincided with an error_logs burst. After D,
 * the at-intake-correlation is the load-bearing path: it turns "user
 * reports broken page during outage" into a real-time HIGH alert
 * routed through B3 within 10s of submit.
 */

import { eq } from "drizzle-orm";
import { problemReports } from "../schema.js";
import type { Db } from "../db.js";
import { getErrorLogsBurstWindow } from "../error-logs-burst.js";
import { HIGH_THRESHOLD, LOOKBACK_MINUTES, LOOKAHEAD_MINUTES } from "./intake.js";

export interface CorrelateCoreOptions {
  /** When true (default), update severity=HIGH on the row if the
   *  re-correlation crosses HIGH_THRESHOLD. False = report-only. */
  bumpSeverity?: boolean;
}

export interface CorrelateCoreResult {
  id: string;
  previousSeverity: "LOW" | "HIGH";
  previousCorrelatedErrorCount: number;
  newSeverity: "LOW" | "HIGH";
  newCorrelatedErrorCount: number;
  /** True when the new count meets HIGH_THRESHOLD. */
  crossed: boolean;
  /** True when an UPDATE actually fired (skipped on no-op when
   *  bumpSeverity is true but the new values match the old). */
  mutated: boolean;
  bySource: Array<{ source: string | null; count: number }>;
  window: { since: string; until: string };
}

/**
 * Re-run the error_logs burst-watch correlation for a problem report.
 * Returns null when the id doesn't match an existing row (so callers
 * can map that to a 404 / "not found" response).
 */
export async function correlateProblemReportCore(
  db: Db,
  id: string,
  opts: CorrelateCoreOptions = {}
): Promise<CorrelateCoreResult | null> {
  const [row] = await db.select().from(problemReports).where(eq(problemReports.id, id)).limit(1);
  if (!row) return null;

  const since = new Date(row.createdAt.getTime() - LOOKBACK_MINUTES * 60_000);
  const until = new Date(row.createdAt.getTime() + LOOKAHEAD_MINUTES * 60_000);
  const burst = await getErrorLogsBurstWindow(db, {
    since,
    until,
    minCount: HIGH_THRESHOLD,
    topSourcesLimit: 10,
  });

  const newSeverity: "LOW" | "HIGH" = burst.totalErrors >= HIGH_THRESHOLD ? "HIGH" : "LOW";
  const bumped = opts.bumpSeverity !== false; // default true
  let mutated = false;
  if (bumped && (burst.totalErrors !== row.correlatedErrorCount || newSeverity !== row.severity)) {
    await db
      .update(problemReports)
      .set({
        severity: newSeverity,
        correlatedErrorCount: burst.totalErrors,
      })
      .where(eq(problemReports.id, id));
    mutated = true;
  }

  return {
    id: row.id,
    previousSeverity: row.severity,
    previousCorrelatedErrorCount: row.correlatedErrorCount,
    newSeverity,
    newCorrelatedErrorCount: burst.totalErrors,
    crossed: burst.tripped,
    mutated,
    bySource: burst.bySource,
    window: { since: since.toISOString(), until: until.toISOString() },
  };
}
