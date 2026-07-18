/**
 * Health/indexing domain loaders: Site Health issue counts, recent error-log
 * rollup, IndexNow daily submissions + quota, sitemap-completeness ratio, and
 * the time-to-index summary.
 */

import { and, count, desc, gte, sql } from "drizzle-orm";
import { errorLogs, events, indexnowSubmissions, timeToIndexLog, vendors } from "@/lib/db/schema";
import {
  BingApiError,
  BingConfigError,
  getIndexNowQuota,
  type BingEnv,
  type BingIndexNowQuota,
} from "@/lib/bing-webmaster";
import { getCurrentIssues } from "@/lib/site-health";
import { SITEMAP_MIN_COMPLETENESS } from "@takemetothefair/utils";
import type { Db } from "./shared";
import type {
  IndexNowCard,
  RecentErrorsCard,
  SiteHealthCard,
  SitemapQualityCard,
  TimeToIndexCard,
} from "./types";

// ── Row 2 — Health & action ─────────────────────────────────────────

export async function loadSiteHealth(db: Db): Promise<SiteHealthCard> {
  const issues = await getCurrentIssues(db, { hideSnoozed: true });
  let errors = 0;
  let warnings = 0;
  let notices = 0;
  for (const i of issues) {
    if (i.severity === "ERROR") errors++;
    else if (i.severity === "WARNING") warnings++;
    else notices++;
  }
  return { errors, warnings, notices, total: errors + warnings + notices };
}

export async function loadIndexNow(
  db: Db,
  env: BingEnv,
  todayStartDate: Date
): Promise<IndexNowCard> {
  const todayRows = await db
    .select({
      status: indexnowSubmissions.status,
      c: count(),
    })
    .from(indexnowSubmissions)
    .where(gte(indexnowSubmissions.timestamp, todayStartDate))
    .groupBy(indexnowSubmissions.status);

  let total = 0;
  let success = 0;
  let failures = 0;
  let deferred = 0;
  for (const r of todayRows) {
    total += r.c;
    if (r.status === "success") success += r.c;
    else if (r.status === "failure") failures += r.c;
    // OPE-243: `skipped` = the circuit breaker deferred the submission (paused /
    // 429-latched). A deferral is NOT a success — counting it as one is what let
    // 20 days of silence read as green.
    else if (r.status === "skipped") deferred += r.c;
  }
  const attempts = success + failures; // rows where Bing was actually contacted

  let quota: BingIndexNowQuota | null = null;
  let quotaError: string | undefined;
  try {
    quota = await getIndexNowQuota(env);
  } catch (e) {
    if (e instanceof BingConfigError) quotaError = "Bing not configured";
    else if (e instanceof BingApiError) quotaError = `Bing API error: ${e.detail}`;
    else quotaError = e instanceof Error ? e.message : "Bing unknown error";
  }

  return {
    todaySubmissions: total,
    // OPE-243: rate over ATTEMPTS (success+failure), not all rows. And when
    // there were no attempts but deferrals piled up (breaker paused), that is
    // NOT 100% success — it's a silent integration, so report 0. Only a truly
    // idle day (no attempts, no deferrals) reads as healthy (1).
    todaySuccessRate: attempts > 0 ? success / attempts : deferred > 0 ? 0 : 1,
    todayFailures: failures,
    todayDeferred: deferred,
    quota,
    quotaError,
  };
}

export async function loadRecentErrors(db: Db, sinceDate: Date): Promise<RecentErrorsCard> {
  const rows = await db
    .select({
      source: errorLogs.source,
      c: count(),
    })
    .from(errorLogs)
    .where(gte(errorLogs.timestamp, sinceDate))
    .groupBy(errorLogs.source)
    .orderBy(desc(sql`COUNT(*)`));

  const total = rows.reduce((acc, r) => acc + r.c, 0);
  const top = rows.slice(0, 3).map((r) => ({ source: r.source ?? "(unknown)", count: r.c }));
  return { last24hCount: total, topSources: top };
}

export async function loadSitemapQuality(db: Db): Promise<SitemapQualityCard> {
  // Pass = passes the §10.2 sitemap completeness gate (>= SITEMAP_MIN_COMPLETENESS).
  // Filters: vendors must not be soft-deleted; events any status (the sitemap
  // narrows further on isPublicEventStatus, but for the quality ratio we
  // measure the full population).
  const [vTotal, vPass, eTotal, ePass] = await Promise.all([
    db
      .select({ n: count() })
      .from(vendors)
      .where(sql`${vendors.deletedAt} IS NULL`),
    db
      .select({ n: count() })
      .from(vendors)
      .where(
        and(
          sql`${vendors.deletedAt} IS NULL`,
          gte(vendors.completenessScore, SITEMAP_MIN_COMPLETENESS)
        )
      ),
    db.select({ n: count() }).from(events),
    db
      .select({ n: count() })
      .from(events)
      .where(gte(events.completenessScore, SITEMAP_MIN_COMPLETENESS)),
  ]);
  const vTotalN = vTotal[0]?.n ?? 0;
  const vPassN = vPass[0]?.n ?? 0;
  const eTotalN = eTotal[0]?.n ?? 0;
  const ePassN = ePass[0]?.n ?? 0;
  const overallTotal = vTotalN + eTotalN;
  return {
    vendors: { pass: vPassN, total: vTotalN },
    events: { pass: ePassN, total: eTotalN },
    overall_pass_rate: overallTotal > 0 ? (vPassN + ePassN) / overallTotal : 0,
    threshold: SITEMAP_MIN_COMPLETENESS,
  };
}

export async function loadTimeToIndex(db: Db): Promise<TimeToIndexCard> {
  // Median computed in JS — SQLite has no MEDIAN aggregate. Pull resolved
  // lag values up to 1000 most recent (cheap to sort in-memory).
  const [resolvedRows, unresolvedRow] = await Promise.all([
    db
      .select({ lagSeconds: timeToIndexLog.lagSeconds })
      .from(timeToIndexLog)
      .where(sql`${timeToIndexLog.lagSeconds} IS NOT NULL`)
      .orderBy(desc(timeToIndexLog.firstCrawlAt))
      .limit(1000),
    db
      .select({ n: count() })
      .from(timeToIndexLog)
      .where(sql`${timeToIndexLog.firstCrawlAt} IS NULL`),
  ]);
  const lags = resolvedRows
    .map((r) => r.lagSeconds)
    .filter((n): n is number => typeof n === "number")
    .sort((a, b) => a - b);
  const n = lags.length;
  if (n === 0) {
    return {
      resolved: 0,
      unresolved: unresolvedRow[0]?.n ?? 0,
      median_seconds: null,
      p90_seconds: null,
      avg_seconds: null,
    };
  }
  const median = lags[Math.floor(n / 2)];
  const p90 = lags[Math.floor(n * 0.9)];
  const avg = Math.round(lags.reduce((s, v) => s + v, 0) / n);
  return {
    resolved: n,
    unresolved: unresolvedRow[0]?.n ?? 0,
    median_seconds: median,
    p90_seconds: p90,
    avg_seconds: avg,
  };
}
