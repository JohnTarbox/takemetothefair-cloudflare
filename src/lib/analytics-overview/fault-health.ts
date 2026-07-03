/**
 * OPE-83 — render-fault health KPIs for the /admin/analytics overview.
 *
 * Sourced from the OPE-81 `fault_signatures` ledger (all rows — the ledger is
 * bounded to distinct render-fault signatures, cheap to reduce in JS) plus a
 * windowed slice of `error_logs` for the server-vs-client message split.
 * Mirrors the in-memory reduction style of loadSiteHealth: a couple of cheap
 * selects, then plain JS math. Every ratio NULL-guards its denominator so a
 * cold ledger renders "—" instead of NaN/divide-by-zero.
 */

import { count, gte } from "drizzle-orm";
import { errorLogs, faultSignatures } from "@/lib/db/schema";
import type { Db } from "./shared";
import type { RenderFaultHealthCard } from "./types";

const MS_PER_HOUR = 3_600_000;
// A signature is still "open" until it's resolved (done). Mirrors the
// unresolved set the alerting path (selectStaleFaultReds) escalates on.
const OPEN_STATUSES = new Set(["proposed", "filed", "regressed"]);

export async function loadRenderFaultHealth(
  db: Db,
  windowDays: number
): Promise<RenderFaultHealthCard> {
  const sinceDate = new Date(Date.now() - windowDays * 86400 * 1000);

  const [sigRows, errorRows] = await Promise.all([
    // Whole ledger — bounded to distinct signatures, reduced in memory.
    db
      .select({
        status: faultSignatures.status,
        opeId: faultSignatures.opeId,
        count: faultSignatures.count,
        firstSeen: faultSignatures.firstSeen,
        filedAt: faultSignatures.filedAt,
      })
      .from(faultSignatures),
    // Windowed error-log source split (same grouping shape as loadRecentErrors).
    db
      .select({ source: errorLogs.source, c: count() })
      .from(errorLogs)
      .where(gte(errorLogs.timestamp, sinceDate))
      .groupBy(errorLogs.source),
  ]);

  const totalSignatures = sigRows.length;

  let openSignatures = 0;
  let autoDetected = 0; // ope_id set → pipeline-filed share
  let doneCount = 0;
  let regressedCount = 0;
  let occurrenceSum = 0; // Σ count across the ledger
  let mttdSumHours = 0;
  let mttdFiledRows = 0;

  for (const r of sigRows) {
    if (OPEN_STATUSES.has(r.status)) openSignatures++;
    if (r.opeId) autoDetected++;
    if (r.status === "done") doneCount++;
    if (r.status === "regressed") regressedCount++;
    occurrenceSum += r.count;
    // MTTD = detection lag (filedAt − firstSeen) averaged over rows that have
    // actually been filed. firstSeen is NOT NULL; filedAt is the guard.
    if (r.filedAt && r.firstSeen) {
      const hours = (r.filedAt.getTime() - r.firstSeen.getTime()) / MS_PER_HOUR;
      if (Number.isFinite(hours)) {
        mttdSumHours += hours;
        mttdFiledRows++;
      }
    }
  }

  let totalErrorRows = 0;
  let serverRenderRows = 0;
  for (const e of errorRows) {
    totalErrorRows += e.c;
    if (e.source === "server-render") serverRenderRows += e.c;
  }

  const doneOrRegressed = doneCount + regressedCount;

  return {
    totalSignatures,
    openSignatures,
    autoDetectedPct: totalSignatures > 0 ? autoDetected / totalSignatures : null,
    meanTimeToDetectHours: mttdFiledRows > 0 ? mttdSumHours / mttdFiledRows : null,
    serverMessagePct: totalErrorRows > 0 ? serverRenderRows / totalErrorRows : null,
    dedupCollapseRate: occurrenceSum > 0 ? 1 - totalSignatures / occurrenceSum : null,
    recurrenceRate: doneOrRegressed > 0 ? regressedCount / doneOrRegressed : null,
    // NOT YET INSTRUMENTED — reserved for a future CI-guard-coverage source
    // (share of render paths behind an error boundary / guard). Always null so
    // the tile renders "n/a" until that pipeline exists.
    guardCoveragePct: null,
    windowDays,
  };
}
