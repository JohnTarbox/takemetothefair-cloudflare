/**
 * OPE-391 Block B — the Goodwill discrepancy pipeline, read for the Site
 * Health tab.
 *
 * There was no Data Health surface anywhere in admin before this
 * (`/admin/data-health`, `/admin/recommendations` and `/admin/cpi` all 404),
 * so this is net-new rather than a move.
 *
 * The bucketing rule is NOT reimplemented here — `summarizeResolutions` comes
 * from `@takemetothefair/db-schema`, the same function the MCP report and the
 * nightly snapshot writer use. That is the point: this file would have been
 * the THIRD hand-rolled copy, and the second copy already persists its answer
 * into a column with 87 days of history.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import {
  eventDiscrepancies,
  goodwillHealthSnapshots,
  adminActions,
  summarizeResolutions,
  isSnapshotStale,
  snapshotAgeDays,
  DATA_HEALTH_WINDOW_DAYS,
  type ResolutionSummary,
} from "@/lib/db/schema";

type Db = DrizzleD1Database<typeof schema>;

export interface DataHealthTrendPoint {
  date: string;
  openCount: number;
  outreachCandidates: number;
  weightedPrioritySum: number;
}

export interface DataHealthReport {
  /** Counted NOW, not read from the nightly snapshot. */
  liveOpen: number;
  liveOutreachCandidates: number;
  liveWeightedPriority: number;
  resolutions: ResolutionSummary;
  operatorOverrides28d: number;
  /** Oldest → newest, ready to plot. */
  trend: DataHealthTrendPoint[];
  /** The newest snapshot's date, or null when the table is empty. */
  latestSnapshotDate: string | null;
  latestSnapshotAgeDays: number | null;
  /** True when the nightly canary has missed a night — see below. */
  snapshotStale: boolean;
  /**
   * `liveOpen` minus the newest snapshot's `open_count`.
   *
   * Small non-zero values are normal: rows are detected between the canary's
   * run and this page load. A LARGE gap, or staleness, means the trend line is
   * drawing history that no longer describes the present — the "frozen at its
   * last good value" failure that looks exactly like stability.
   */
  liveVsSnapshotDelta: number | null;
}

export async function getDataHealthReport(
  db: Db,
  opts: { trendDays?: number; now?: Date } = {}
): Promise<DataHealthReport> {
  // 28, not 14. The 2026-08-04 bulk reclassification (~7,080 → ~199) is the
  // single most informative feature of this series, and it falls outside a
  // 14-day window — a shorter trend draws a flat line and implies nothing
  // ever happened.
  const trendDays = opts.trendDays ?? DATA_HEALTH_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const windowStart = new Date(now.getTime() - DATA_HEALTH_WINDOW_DAYS * 86_400_000);

  const [openRow, resolutionRows, overrideRow, trendRows] = await Promise.all([
    db
      .select({
        total: sql<number>`COUNT(*)`,
        candidates: sql<number>`COALESCE(SUM(CASE WHEN ${eventDiscrepancies.outreachCandidate} THEN 1 ELSE 0 END), 0)`,
        weighted: sql<number>`COALESCE(SUM(${eventDiscrepancies.outreachPriorityScore}), 0)`,
      })
      .from(eventDiscrepancies)
      .where(eq(eventDiscrepancies.resolutionStatus, "open")),
    db
      .select({
        status: eventDiscrepancies.resolutionStatus,
        count: sql<number>`COUNT(*)`,
      })
      .from(eventDiscrepancies)
      .where(gte(eventDiscrepancies.resolvedAt, windowStart))
      .groupBy(eventDiscrepancies.resolutionStatus),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(adminActions)
      .where(
        and(
          sql`${adminActions.action} LIKE 'discrepancy.%'`,
          // D1 stores these as SECONDS in raw SQL; a millisecond value here
          // matches nothing and returns a clean zero that reads as success.
          sql`${adminActions.createdAt} > ${Math.floor(windowStart.getTime() / 1000)}`
        )
      ),
    db
      .select({
        date: goodwillHealthSnapshots.snapshotDate,
        openCount: goodwillHealthSnapshots.openCount,
        outreachCandidates: goodwillHealthSnapshots.outreachCandidateCount,
        weightedPrioritySum: goodwillHealthSnapshots.weightedPrioritySum,
      })
      .from(goodwillHealthSnapshots)
      .orderBy(desc(goodwillHealthSnapshots.snapshotDate))
      .limit(trendDays),
  ]);

  const liveOpen = Number(openRow[0]?.total ?? 0);
  // Newest-first from the query (so LIMIT takes the most recent N), reversed
  // for plotting.
  const latestSnapshotDate = trendRows[0]?.date ?? null;
  const trend: DataHealthTrendPoint[] = trendRows
    .map((r) => ({
      date: r.date,
      openCount: Number(r.openCount),
      outreachCandidates: Number(r.outreachCandidates),
      weightedPrioritySum: Number(r.weightedPrioritySum),
    }))
    .reverse();

  return {
    liveOpen,
    liveOutreachCandidates: Number(openRow[0]?.candidates ?? 0),
    liveWeightedPriority: Number(openRow[0]?.weighted ?? 0),
    resolutions: summarizeResolutions(resolutionRows),
    operatorOverrides28d: Number(overrideRow[0]?.count ?? 0),
    trend,
    latestSnapshotDate,
    latestSnapshotAgeDays: snapshotAgeDays(latestSnapshotDate, now),
    snapshotStale: isSnapshotStale(latestSnapshotDate, now),
    liveVsSnapshotDelta:
      trendRows[0] === undefined ? null : liveOpen - Number(trendRows[0].openCount),
  };
}
