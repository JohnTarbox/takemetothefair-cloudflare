/**
 * Shared `error_logs` burst-watch helper (B1 — REL1' / UR1 incident-response
 * cluster, 2026-06-04).
 *
 * Two callers consume the same logic:
 *   1. `runScheduledPageErrorCanary` (page-error-canary.ts) — REL1' §0
 *      alert. Previously aggregated all page-fetcher errors into one
 *      window-total; this helper exposes a `bySource` breakdown so the
 *      canary can alert on single-source spikes (e.g. `getEvents` spiking
 *      while every other fetcher is healthy).
 *   2. UR1 problem-report intake (email-handler.ts + report-problem
 *      POST handler) — when a report lands, look at the −30m / +5m
 *      window around `created_at`. If count ≥ 10, escalate severity
 *      HIGH and route through the technical-channel alert because the
 *      user's report likely co-occurred with a real outage.
 *
 * One COUNT + one optional GROUP BY query per call — cheap enough for
 * both the every-10-min cron and the per-report intake path.
 */

import { and, eq, gte, lt, like, sql, desc } from "drizzle-orm";
import { errorLogs } from "./schema.js";
import type { Db } from "./db.js";

export interface BurstWindowOptions {
  /** Inclusive lower bound on `error_logs.timestamp`. */
  since: Date;
  /** Exclusive upper bound. */
  until: Date;
  /** Optional SQL LIKE pattern on `source` (e.g. `app/%page.tsx:%`).
   *  When omitted, every error_logs row in the window is counted. */
  sourcePattern?: string;
  /** Inclusive lower bound for the `tripped` boolean. Default 10
   *  (matches UR1's HIGH-severity threshold). */
  minCount?: number;
  /** Restrict to a level value. Default "error" (skips info/warn rows). */
  level?: string;
  /** Maximum sources returned in the bySource breakdown. Default 10. */
  topSourcesLimit?: number;
}

export interface BurstWindowResult {
  totalErrors: number;
  bySource: Array<{ source: string | null; count: number }>;
  /** True when `totalErrors >= minCount`. */
  tripped: boolean;
  since: Date;
  until: Date;
}

export async function getErrorLogsBurstWindow(
  db: Db,
  opts: BurstWindowOptions
): Promise<BurstWindowResult> {
  const minCount = opts.minCount ?? 10;
  const topSourcesLimit = opts.topSourcesLimit ?? 10;
  const level = opts.level ?? "error";

  const predicates = [
    gte(errorLogs.timestamp, opts.since),
    lt(errorLogs.timestamp, opts.until),
    eq(errorLogs.level, level),
  ];
  if (opts.sourcePattern) {
    predicates.push(like(errorLogs.source, opts.sourcePattern));
  }
  const where = and(...predicates);

  const totalRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(errorLogs)
    .where(where);
  const totalErrors = totalRows[0]?.count ?? 0;

  // Per-source breakdown — only when we have signal (saves a SELECT
  // on the very common zero-error path).
  let bySource: Array<{ source: string | null; count: number }> = [];
  if (totalErrors > 0) {
    bySource = await db
      .select({ source: errorLogs.source, count: sql<number>`count(*)` })
      .from(errorLogs)
      .where(where)
      .groupBy(errorLogs.source)
      .orderBy(desc(sql`count(*)`))
      .limit(topSourcesLimit);
  }

  return {
    totalErrors,
    bySource,
    tripped: totalErrors >= minCount,
    since: opts.since,
    until: opts.until,
  };
}
