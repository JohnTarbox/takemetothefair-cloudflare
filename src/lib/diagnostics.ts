/**
 * §10.3 diagnostic dashboard data aggregator.
 *
 * Powers /admin/diagnostics — a separate surface from /admin/analytics that
 * focuses on pipeline health rather than business metrics. Surfaces the
 * tells the operator needs to know whether the data plumbing is OK
 * BEFORE trusting any number on the analytics dashboard.
 */
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { enrichmentLog, errorLogs, indexnowSubmissions, timeToIndexLog } from "@/lib/db/schema";

type Db = DrizzleD1Database<typeof schema>;

export type ErrorGroup = {
  source: string;
  message: string;
  count: number;
  lastSeenMs: number;
};

export type EnrichmentSourceHealth = {
  source: string;
  total: number;
  success: number;
  failure: number;
  skipped: number;
  successRate: number;
};

export type IndexNowHealth = {
  windowDays: number;
  total: number;
  success: number;
  failure: number;
  successRate: number;
};

export type TimeToIndexHealth = {
  resolved: number;
  unresolved: number;
  resolvedRate: number;
  oldestUnresolvedAgeSeconds: number | null;
};

export type DiagnosticsSnapshot = {
  generatedAt: Date;
  errorGroups: ErrorGroup[];
  enrichmentBySource: EnrichmentSourceHealth[];
  indexnow: IndexNowHealth;
  timeToIndex: TimeToIndexHealth;
};

const ERROR_WINDOW_DAYS = 7;
const ENRICHMENT_WINDOW_DAYS = 7;
const INDEXNOW_WINDOW_DAYS = 7;

export async function loadDiagnosticsSnapshot(db: Db): Promise<DiagnosticsSnapshot> {
  const now = new Date();
  const errorSince = new Date(now.getTime() - ERROR_WINDOW_DAYS * 86400 * 1000);
  const enrichmentSince = new Date(now.getTime() - ENRICHMENT_WINDOW_DAYS * 86400 * 1000);
  const indexnowSince = new Date(now.getTime() - INDEXNOW_WINDOW_DAYS * 86400 * 1000);

  const [errorGroups, enrichmentBySource, indexnow, timeToIndex] = await Promise.all([
    loadErrorGroups(db, errorSince),
    loadEnrichmentBySource(db, enrichmentSince),
    loadIndexNowHealth(db, indexnowSince),
    loadTimeToIndexHealth(db),
  ]);

  return { generatedAt: now, errorGroups, enrichmentBySource, indexnow, timeToIndex };
}

async function loadErrorGroups(db: Db, sinceDate: Date): Promise<ErrorGroup[]> {
  // Group by (source, first 80 chars of message) — message tail often has a
  // unique id that would defeat grouping, so truncate.
  const rows = await db
    .select({
      source: errorLogs.source,
      message: errorLogs.message,
      timestamp: errorLogs.timestamp,
    })
    .from(errorLogs)
    .where(gte(errorLogs.timestamp, sinceDate))
    .orderBy(desc(errorLogs.timestamp))
    .limit(2000);

  const groups = new Map<string, ErrorGroup>();
  for (const r of rows) {
    const src = r.source ?? "(unknown)";
    const key = `${src}::${(r.message ?? "").slice(0, 80)}`;
    const existing = groups.get(key);
    const ts = r.timestamp.getTime();
    if (existing) {
      existing.count++;
      if (ts > existing.lastSeenMs) existing.lastSeenMs = ts;
    } else {
      groups.set(key, {
        source: src,
        message: (r.message ?? "").slice(0, 80),
        count: 1,
        lastSeenMs: ts,
      });
    }
  }
  return Array.from(groups.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);
}

async function loadEnrichmentBySource(db: Db, sinceDate: Date): Promise<EnrichmentSourceHealth[]> {
  const rows = await db
    .select({
      source: enrichmentLog.source,
      status: enrichmentLog.status,
      n: count(),
    })
    .from(enrichmentLog)
    .where(gte(enrichmentLog.attemptedAt, sinceDate))
    .groupBy(enrichmentLog.source, enrichmentLog.status);

  const bySource = new Map<string, EnrichmentSourceHealth>();
  for (const r of rows) {
    let entry = bySource.get(r.source);
    if (!entry) {
      entry = {
        source: r.source,
        total: 0,
        success: 0,
        failure: 0,
        skipped: 0,
        successRate: 0,
      };
      bySource.set(r.source, entry);
    }
    entry.total += r.n;
    if (r.status === "success") entry.success += r.n;
    else if (r.status === "failure") entry.failure += r.n;
    else if (r.status === "skipped") entry.skipped += r.n;
  }
  for (const e of bySource.values()) {
    e.successRate = e.total > 0 ? e.success / e.total : 0;
  }
  return Array.from(bySource.values()).sort((a, b) => b.total - a.total);
}

async function loadIndexNowHealth(db: Db, sinceDate: Date): Promise<IndexNowHealth> {
  const [totalRow, successRow, failureRow] = await Promise.all([
    db
      .select({ n: count() })
      .from(indexnowSubmissions)
      .where(gte(indexnowSubmissions.timestamp, sinceDate)),
    db
      .select({ n: count() })
      .from(indexnowSubmissions)
      .where(
        and(
          gte(indexnowSubmissions.timestamp, sinceDate),
          eq(indexnowSubmissions.status, "success")
        )
      ),
    db
      .select({ n: count() })
      .from(indexnowSubmissions)
      .where(
        and(
          gte(indexnowSubmissions.timestamp, sinceDate),
          eq(indexnowSubmissions.status, "failure")
        )
      ),
  ]);
  const total = totalRow[0]?.n ?? 0;
  const success = successRow[0]?.n ?? 0;
  const failure = failureRow[0]?.n ?? 0;
  return {
    windowDays: INDEXNOW_WINDOW_DAYS,
    total,
    success,
    failure,
    successRate: total > 0 ? success / total : 0,
  };
}

async function loadTimeToIndexHealth(db: Db): Promise<TimeToIndexHealth> {
  const [resolvedRow, unresolvedRow, oldestUnresolved] = await Promise.all([
    db
      .select({ n: count() })
      .from(timeToIndexLog)
      .where(sql`${timeToIndexLog.firstCrawlAt} IS NOT NULL`),
    db
      .select({ n: count() })
      .from(timeToIndexLog)
      .where(sql`${timeToIndexLog.firstCrawlAt} IS NULL`),
    db
      .select({ submitted: timeToIndexLog.indexnowSubmittedAt })
      .from(timeToIndexLog)
      .where(sql`${timeToIndexLog.firstCrawlAt} IS NULL`)
      .orderBy(timeToIndexLog.indexnowSubmittedAt)
      .limit(1),
  ]);
  const resolved = resolvedRow[0]?.n ?? 0;
  const unresolved = unresolvedRow[0]?.n ?? 0;
  const total = resolved + unresolved;
  const oldestSeconds = oldestUnresolved[0]
    ? Math.floor((Date.now() - oldestUnresolved[0].submitted.getTime()) / 1000)
    : null;
  return {
    resolved,
    unresolved,
    resolvedRate: total > 0 ? resolved / total : 0,
    oldestUnresolvedAgeSeconds: oldestSeconds,
  };
}
