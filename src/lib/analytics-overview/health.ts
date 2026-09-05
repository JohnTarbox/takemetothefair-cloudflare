/**
 * Health/indexing domain loaders: Site Health issue counts, recent error-log
 * rollup, IndexNow daily submissions + quota, sitemap-completeness ratio, and
 * the time-to-index summary.
 */

import { and, count, desc, gte, sql } from "drizzle-orm";
import { errorLogs, events, indexnowSubmissions, timeToIndexLog, vendors } from "@/lib/db/schema";
import { freshness, rate } from "./render-state";
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

  // The last date Bing was ACTUALLY contacted (success or failure) — a
  // `skipped` row is the breaker declining to send, not a send. This is what
  // "paused since ..." means on the tile.
  const lastAttemptRow = await db
    .select({
      lastAt: sql<string | null>`MAX(date(${indexnowSubmissions.timestamp}, 'unixepoch'))`,
    })
    .from(indexnowSubmissions)
    .where(sql`${indexnowSubmissions.status} IN ('success','failure')`);

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

  // ⚠️ OPE-808 — a rate needs a denominator.
  //
  // OPE-243 half-saw this and picked two different wrong answers: with no
  // attempts it returned 0 when deferrals existed and 1 when they did not. That
  // is why the same tile read "100% success" on one page load and "0% success"
  // on the next, from the same data — the branch flipped on whether a `skipped`
  // row happened to land that day. Zero attempts is not 0% and not 100%; it is
  // "we did not contact Bing", and the tile must say so.
  //
  // Measured 2026-09-05: last actual attempt was 2026-08-11 (a failure); 975
  // `skipped` rows since, zero successes in 40 days.
  const rateReason =
    deferred > 0 ? `breaker deferring — ${deferred} skipped today` : "no sends today";
  const todayRate = rate(success, attempts, rateReason);

  return {
    todaySubmissions: total,
    /** @deprecated OPE-808 — read `todayRate`, which can say "undefined". */
    todaySuccessRate: attempts > 0 ? success / attempts : deferred > 0 ? 0 : 1,
    todayRate,
    lastAttemptAt: lastAttemptRow[0]?.lastAt ?? null,
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
    /** @deprecated OPE-808 — read `overallRate`, which can say "undefined". */
    overall_pass_rate: overallTotal > 0 ? (vPassN + ePassN) / overallTotal : 0,
    // An empty catalogue is not a 0% pass rate — it is no measurement. Latent
    // today (the site has vendors and events), fixed because it is the same
    // shape that made the IndexNow tile report 100% and 0% from one dataset.
    overallRate: rate(vPassN + ePassN, overallTotal, "no vendors or events to measure"),
    threshold: SITEMAP_MIN_COMPLETENESS,
  };
}

/** The in-memory sort cap. Named, because it is reported rather than hidden. */
export const TIME_TO_INDEX_SAMPLE_CAP = 1000;

export async function loadTimeToIndex(db: Db): Promise<TimeToIndexCard> {
  // Median computed in JS — SQLite has no MEDIAN aggregate. Pull resolved
  // lag values up to the cap (cheap to sort in-memory).
  //
  // ⚠️ OPE-808 — this query samples, and the tile used to print the sample size
  // as `resolved`. On 2026-09-05 that read "1,000 resolved" against a store
  // holding 5,501, and the capped sample reported a 61.6d mean where the true
  // population mean is 40.8d. A LIMIT is not a count. Both the population total
  // and the feed's last admission are now fetched so the card can say which.
  const [resolvedRows, unresolvedRow, resolvedTotalRow, feedRow] = await Promise.all([
    db
      .select({ lagSeconds: timeToIndexLog.lagSeconds })
      .from(timeToIndexLog)
      .where(sql`${timeToIndexLog.lagSeconds} IS NOT NULL`)
      .orderBy(desc(timeToIndexLog.firstCrawlAt))
      .limit(TIME_TO_INDEX_SAMPLE_CAP),
    db
      .select({ n: count() })
      .from(timeToIndexLog)
      .where(sql`${timeToIndexLog.firstCrawlAt} IS NULL`),
    db
      .select({ n: count() })
      .from(timeToIndexLog)
      .where(sql`${timeToIndexLog.lagSeconds} IS NOT NULL`),
    // Freshness is judged on the column that ADMITS rows. `first_crawl_at`
    // still advances (stragglers resolving), which is exactly why reading
    // freshness off it reports a healthy feed that has in fact been closed
    // since 2026-06-13.
    db
      .select({ maxAdmitted: sql<number | null>`MAX(${timeToIndexLog.indexnowSubmittedAt})` })
      .from(timeToIndexLog),
  ]);
  const lags = resolvedRows
    .map((r) => r.lagSeconds)
    .filter((n): n is number => typeof n === "number")
    .sort((a, b) => a - b);
  const n = lags.length;
  const resolvedTotal = resolvedTotalRow[0]?.n ?? n;
  const rawAdmitted = feedRow[0]?.maxAdmitted ?? null;
  // D1 stores these columns as epoch SECONDS in raw SQL.
  const feedAdmitsRowsAt = rawAdmitted == null ? null : new Date(Number(rawAdmitted) * 1000);
  const freshnessState = freshness(null, "time_to_index_log", feedAdmitsRowsAt);

  if (n === 0) {
    return {
      resolved: 0,
      resolvedTotal,
      sampleCap: TIME_TO_INDEX_SAMPLE_CAP,
      truncated: false,
      feedLastAt: freshnessState.feedLastAt ?? null,
      feedStale: freshnessState.state === "stale",
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
    // `resolved` remains the SAMPLE size (what the stats were computed over),
    // and `resolvedTotal` is the population. The tile renders "N of M sampled"
    // rather than presenting either number alone as the answer.
    resolved: n,
    resolvedTotal,
    sampleCap: TIME_TO_INDEX_SAMPLE_CAP,
    truncated: n >= TIME_TO_INDEX_SAMPLE_CAP && resolvedTotal > n,
    feedLastAt: freshnessState.feedLastAt ?? null,
    feedStale: freshnessState.state === "stale",
    unresolved: unresolvedRow[0]?.n ?? 0,
    median_seconds: median,
    p90_seconds: p90,
    avg_seconds: avg,
  };
}
