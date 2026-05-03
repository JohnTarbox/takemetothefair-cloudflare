/**
 * Data aggregation for the /admin/analytics Overview triage dashboard.
 *
 * Consolidates signals from multiple existing sources (GSC, D1 analytics_events,
 * indexnow_submissions, error_logs, admin_actions, vendors/events/venues counts,
 * Site Health) into a single snapshot for at-a-glance triage. Deeper analysis
 * lives in the per-source tabs and the GA4 sub-route.
 *
 * Timestamp note: this module normalizes between two storage conventions in the
 * codebase — Drizzle `mode: "timestamp"` columns (ms-epoch, e.g. adminActions,
 * vendors.createdAt, events.createdAt) and raw INTEGER columns that hold
 * seconds-epoch (analyticsEvents.timestamp, indexnowSubmissions.timestamp,
 * errorLogs.timestamp). The activity feed merges all three after normalizing to
 * ms-epoch.
 */

import { and, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import {
  adminActions,
  analyticsEvents,
  contentLinks,
  errorLogs,
  events,
  indexnowSubmissions,
  vendors,
  venues,
} from "@/lib/db/schema";
import {
  BingApiError,
  BingConfigError,
  getIndexNowQuota,
  type BingEnv,
  type BingIndexNowQuota,
} from "@/lib/bing-webmaster";
import {
  ScApiError,
  ScConfigError,
  getDailyClicks,
  getSiteSearchQueries,
  type ScEnv,
} from "@/lib/search-console";
import { getCurrentIssues } from "@/lib/site-health";
import { getActiveItems } from "@/lib/recommendations/engine";

type Db = DrizzleD1Database<typeof schema>;

export const ENHANCED_PROFILE_PRICE_USD = 29;

export type WindowKey = "1d" | "7d" | "30d" | "90d";
export const WINDOW_KEYS: WindowKey[] = ["1d", "7d", "30d", "90d"];

export function isWindowKey(value: string | undefined): value is WindowKey {
  return value === "1d" || value === "7d" || value === "30d" || value === "90d";
}

function windowDays(window: WindowKey): number {
  if (window === "1d") return 1;
  if (window === "7d") return 7;
  if (window === "30d") return 30;
  return 90;
}

export type Trend = "up" | "down" | "flat";

function trendOf(current: number, previous: number): Trend {
  if (current > previous) return "up";
  if (current < previous) return "down";
  return "flat";
}

export type Delta = {
  current: number;
  previous: number;
  trend: Trend;
  windowDays: number;
};

export type SearchVisibilityCard =
  | { ok: true; current: number; previous: number; trend: Trend; windowDays: number }
  | { ok: false; reason: string };

export type ConversionsCard = Delta;

export type CatalogGrowthCard = {
  totals: { events: number; venues: number; vendors: number; total: number };
  newInWindow: number;
  newInPriorWindow: number;
  trend: Trend;
  windowDays: number;
};

export type EnhancedProfileRevenueCard = {
  payingVendors: number;
  annualizedUsd: number;
  newInWindow: number;
  newInPriorWindow: number;
  trend: Trend;
  windowDays: number;
};

export type SiteHealthCard = {
  errors: number;
  warnings: number;
  notices: number;
  total: number;
};

export type IndexNowCard = {
  todaySubmissions: number;
  todaySuccessRate: number; // 0..1
  todayFailures: number;
  quota: BingIndexNowQuota | null;
  quotaError?: string;
};

export type RecentErrorsCard = {
  last24hCount: number;
  topSources: Array<{ source: string; count: number }>;
};

export type BlogCoverageCard = {
  events: { uncovered: number; total: number };
  vendors: { uncovered: number; total: number };
  venues: { uncovered: number; total: number };
  totalUncovered: number;
  totalEntities: number;
};

export type RecommendationsSummaryCard = {
  totalItems: number;
  totalRules: number;
  // Highest severity present in the active set, or null if zero items.
  // Drives the card's border/icon color.
  maxSeverity: "red" | "yellow" | "blue" | null;
  redCount: number;
  yellowCount: number;
  blueCount: number;
};

export type SparklinePoint = { date: string; value: number };

export type ActivityEntry = {
  // ms-epoch
  ts: number;
  kind: "admin" | "indexnow" | "conversion";
  description: string;
  href?: string;
  actor?: string | null;
};

export type OverviewSnapshot = {
  window: WindowKey;
  generatedAt: Date;
  searchVisibility: SearchVisibilityCard;
  conversions: ConversionsCard;
  catalogGrowth: CatalogGrowthCard;
  enhancedProfileRevenue: EnhancedProfileRevenueCard;
  siteHealth: SiteHealthCard;
  indexnow: IndexNowCard;
  recentErrors: RecentErrorsCard;
  recommendations: RecommendationsSummaryCard;
  blogCoverage: BlogCoverageCard;
  conversionsSparkline: SparklinePoint[];
  publishingSparkline: SparklinePoint[];
  searchVisibilitySparkline: SparklinePoint[];
  activity: ActivityEntry[];
};

const HIGH_PRIORITY_INDEXNOW_SOURCES = ["venue.create", "vendor.create", "event.approve"] as const;
const CONVERSION_EVENT_NAMES = ["outbound_ticket_click", "outbound_application_click"] as const;
const SPARKLINE_DAYS = 30;

export async function loadOverviewSnapshot(
  db: Db,
  env: ScEnv & BingEnv,
  window: WindowKey
): Promise<OverviewSnapshot> {
  // All windows expressed as Date objects now that every operational table
  // uses Drizzle mode:"timestamp" (ms-epoch). Past code juggled both seconds
  // and ms — see plan file for the cleanup workstream.
  const days = windowDays(window);
  const nowMs = Date.now();
  const sinceDate = new Date(nowMs - days * 86400 * 1000);
  const priorStartDate = new Date(nowMs - days * 2 * 86400 * 1000);
  const priorEndDate = sinceDate;
  const sparklineSinceDate = new Date(nowMs - SPARKLINE_DAYS * 86400 * 1000);
  const todayStartUtcDate = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())
  );
  const last24hDate = new Date(nowMs - 86400 * 1000);

  const [
    searchVisibility,
    conversions,
    catalogGrowth,
    enhancedProfileRevenue,
    siteHealth,
    indexnow,
    recentErrors,
    recommendations,
    blogCoverage,
    conversionsSparkline,
    publishingSparkline,
    searchVisibilitySparkline,
    activity,
  ] = await Promise.all([
    loadSearchVisibility(env, days),
    loadConversions(db, sinceDate, priorStartDate, priorEndDate, days),
    loadCatalogGrowth(db, sinceDate, priorStartDate, priorEndDate, days),
    loadEnhancedProfileRevenue(db, sinceDate, priorStartDate, priorEndDate, days),
    loadSiteHealth(db),
    loadIndexNow(db, env, todayStartUtcDate),
    loadRecentErrors(db, last24hDate),
    loadRecommendationsSummary(db),
    loadBlogCoverage(db),
    loadConversionsSparkline(db, sparklineSinceDate),
    loadPublishingSparkline(db, sparklineSinceDate),
    loadSearchVisibilitySparkline(env),
    loadActivity(db, sinceDate),
  ]);

  return {
    window,
    generatedAt: new Date(nowMs),
    searchVisibility,
    conversions,
    catalogGrowth,
    enhancedProfileRevenue,
    siteHealth,
    indexnow,
    recentErrors,
    recommendations,
    blogCoverage,
    conversionsSparkline,
    publishingSparkline,
    searchVisibilitySparkline,
    activity,
  };
}

async function loadSearchVisibilitySparkline(env: ScEnv): Promise<SparklinePoint[]> {
  // GSC daily aggregation. Returns 0-filled empty series on config/api errors so
  // the UI doesn't break — error visibility lives in the Google tab.
  try {
    const rows = await getDailyClicks(env, { days: SPARKLINE_DAYS });
    const byDate = new Map<string, number>();
    for (const r of rows) byDate.set(r.date, r.clicks);
    return fillDailySeries(byDate, SPARKLINE_DAYS);
  } catch (e) {
    if (e instanceof ScConfigError || e instanceof ScApiError) {
      return emptyDailySeries(SPARKLINE_DAYS);
    }
    throw e;
  }
}

async function loadBlogCoverage(db: Db): Promise<BlogCoverageCard> {
  // Mirrors the math used by /admin/coverage: an entity is "uncovered" when no
  // content_links row references it. Counts only APPROVED events to match the
  // denominator on the coverage page (uncovered + covered = approved set).
  const [
    eventTotalRows,
    vendorTotalRows,
    venueTotalRows,
    eventCoveredRows,
    vendorCoveredRows,
    venueCoveredRows,
  ] = await Promise.all([
    db.select({ c: count() }).from(events).where(eq(events.status, "APPROVED")),
    db.select({ c: count() }).from(vendors),
    db.select({ c: count() }).from(venues),
    db
      .select({ c: sql<number>`COUNT(DISTINCT ${contentLinks.targetId})` })
      .from(contentLinks)
      .where(eq(contentLinks.targetType, "EVENT")),
    db
      .select({ c: sql<number>`COUNT(DISTINCT ${contentLinks.targetId})` })
      .from(contentLinks)
      .where(eq(contentLinks.targetType, "VENDOR")),
    db
      .select({ c: sql<number>`COUNT(DISTINCT ${contentLinks.targetId})` })
      .from(contentLinks)
      .where(eq(contentLinks.targetType, "VENUE")),
  ]);

  const eventTotal = eventTotalRows[0]?.c ?? 0;
  const vendorTotal = vendorTotalRows[0]?.c ?? 0;
  const venueTotal = venueTotalRows[0]?.c ?? 0;
  const eventCovered = eventCoveredRows[0]?.c ?? 0;
  const vendorCovered = vendorCoveredRows[0]?.c ?? 0;
  const venueCovered = venueCoveredRows[0]?.c ?? 0;

  const eventsUncovered = Math.max(0, eventTotal - eventCovered);
  const vendorsUncovered = Math.max(0, vendorTotal - vendorCovered);
  const venuesUncovered = Math.max(0, venueTotal - venueCovered);

  return {
    events: { uncovered: eventsUncovered, total: eventTotal },
    vendors: { uncovered: vendorsUncovered, total: vendorTotal },
    venues: { uncovered: venuesUncovered, total: venueTotal },
    totalUncovered: eventsUncovered + vendorsUncovered + venuesUncovered,
    totalEntities: eventTotal + vendorTotal + venueTotal,
  };
}

async function loadRecommendationsSummary(db: Db): Promise<RecommendationsSummaryCard> {
  // Reuses the same active-items query the Recommendations tab uses, so the
  // counts here always agree with what the admin sees on the tab.
  const items = await getActiveItems(db);
  let red = 0;
  let yellow = 0;
  let blue = 0;
  const ruleIds = new Set<string>();
  for (const it of items) {
    ruleIds.add(it.ruleId);
    if (it.severity === "red") red++;
    else if (it.severity === "yellow") yellow++;
    else if (it.severity === "blue") blue++;
  }
  const maxSeverity: "red" | "yellow" | "blue" | null =
    red > 0 ? "red" : yellow > 0 ? "yellow" : blue > 0 ? "blue" : null;
  return {
    totalItems: items.length,
    totalRules: ruleIds.size,
    maxSeverity,
    redCount: red,
    yellowCount: yellow,
    blueCount: blue,
  };
}

// ── Row 1 — KPI cards ──────────────────────────────────────────────

async function loadSearchVisibility(env: ScEnv, days: number): Promise<SearchVisibilityCard> {
  // GSC supports 1d/7d/28d/30d/90d ranges; map non-preset windows to a custom range.
  // We always pull GSC clicks-only (BWT data isn't easily windowable; users drill
  // into the Bing tab for BWT specifics).
  try {
    const presetByDays: Record<number, "last_7d" | "last_28d" | "last_90d"> = {
      7: "last_7d",
      28: "last_28d",
      30: "last_28d",
      90: "last_90d",
    };
    const preset = presetByDays[days];
    const dateRange = preset
      ? { preset }
      : (() => {
          // Custom range: ending 3 days ago (GSC has reporting lag).
          const end = isoDaysAgo(3);
          const start = isoDaysAgo(3 + days);
          return { startDate: start, endDate: end };
        })();
    // rowLimit drives totals: getSiteSearchQueries computes totals.clicks by
    // summing the *returned* rows (after slice). Use 500 (API max) so the
    // headline KPI captures essentially all clicks, not just the top query.
    const result = await getSiteSearchQueries(env, { dateRange, rowLimit: 500 });
    const current = result.totals.clicks;

    // Previous window: roll the same number of days back.
    const priorEnd = isoFromDate(
      new Date(Date.parse(`${result.dateRange.startDate}T00:00:00Z`) - 86400_000)
    );
    const priorStart = isoFromDate(
      new Date(Date.parse(`${result.dateRange.startDate}T00:00:00Z`) - days * 86400_000)
    );
    const priorResult = await getSiteSearchQueries(env, {
      dateRange: { startDate: priorStart, endDate: priorEnd },
      rowLimit: 500,
    });
    const previous = priorResult.totals.clicks;

    return {
      ok: true,
      current,
      previous,
      trend: trendOf(current, previous),
      windowDays: days,
    };
  } catch (error) {
    if (error instanceof ScConfigError) return { ok: false, reason: "GSC not configured" };
    if (error instanceof ScApiError) return { ok: false, reason: `GSC API error: ${error.detail}` };
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "GSC unknown error",
    };
  }
}

function isoDaysAgo(d: number): string {
  const dt = new Date();
  dt.setUTCDate(dt.getUTCDate() - d);
  return dt.toISOString().slice(0, 10);
}

function isoFromDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function loadConversions(
  db: Db,
  sinceDate: Date,
  priorStartDate: Date,
  priorEndDate: Date,
  days: number
): Promise<ConversionsCard> {
  const [currentRows, priorRows] = await Promise.all([
    db
      .select({ c: count() })
      .from(analyticsEvents)
      .where(
        and(
          inArray(analyticsEvents.eventName, [...CONVERSION_EVENT_NAMES]),
          gte(analyticsEvents.timestamp, sinceDate)
        )
      ),
    db
      .select({ c: count() })
      .from(analyticsEvents)
      .where(
        and(
          inArray(analyticsEvents.eventName, [...CONVERSION_EVENT_NAMES]),
          gte(analyticsEvents.timestamp, priorStartDate),
          lt(analyticsEvents.timestamp, priorEndDate)
        )
      ),
  ]);
  const current = currentRows[0]?.c ?? 0;
  const previous = priorRows[0]?.c ?? 0;
  return {
    current,
    previous,
    trend: trendOf(current, previous),
    windowDays: days,
  };
}

async function loadCatalogGrowth(
  db: Db,
  sinceDate: Date,
  priorStartDate: Date,
  priorEndDate: Date,
  days: number
): Promise<CatalogGrowthCard> {
  const [
    eventsTotal,
    venuesTotal,
    vendorsTotal,
    eventsNew,
    venuesNew,
    vendorsNew,
    eventsPrior,
    venuesPrior,
    vendorsPrior,
  ] = await Promise.all([
    db.select({ c: count() }).from(events).where(eq(events.status, "APPROVED")),
    db.select({ c: count() }).from(venues),
    db.select({ c: count() }).from(vendors),
    db
      .select({ c: count() })
      .from(events)
      .where(and(eq(events.status, "APPROVED"), gte(events.createdAt, sinceDate))),
    db.select({ c: count() }).from(venues).where(gte(venues.createdAt, sinceDate)),
    db.select({ c: count() }).from(vendors).where(gte(vendors.createdAt, sinceDate)),
    db
      .select({ c: count() })
      .from(events)
      .where(
        and(
          eq(events.status, "APPROVED"),
          gte(events.createdAt, priorStartDate),
          lt(events.createdAt, priorEndDate)
        )
      ),
    db
      .select({ c: count() })
      .from(venues)
      .where(and(gte(venues.createdAt, priorStartDate), lt(venues.createdAt, priorEndDate))),
    db
      .select({ c: count() })
      .from(vendors)
      .where(and(gte(vendors.createdAt, priorStartDate), lt(vendors.createdAt, priorEndDate))),
  ]);

  const totals = {
    events: eventsTotal[0]?.c ?? 0,
    venues: venuesTotal[0]?.c ?? 0,
    vendors: vendorsTotal[0]?.c ?? 0,
  };
  const newInWindow = (eventsNew[0]?.c ?? 0) + (venuesNew[0]?.c ?? 0) + (vendorsNew[0]?.c ?? 0);
  const newInPriorWindow =
    (eventsPrior[0]?.c ?? 0) + (venuesPrior[0]?.c ?? 0) + (vendorsPrior[0]?.c ?? 0);

  return {
    totals: { ...totals, total: totals.events + totals.venues + totals.vendors },
    newInWindow,
    newInPriorWindow,
    trend: trendOf(newInWindow, newInPriorWindow),
    windowDays: days,
  };
}

async function loadEnhancedProfileRevenue(
  db: Db,
  sinceDate: Date,
  priorStartDate: Date,
  priorEndDate: Date,
  days: number
): Promise<EnhancedProfileRevenueCard> {
  const [paying, newRows, priorRows] = await Promise.all([
    db.select({ c: count() }).from(vendors).where(eq(vendors.enhancedProfile, true)),
    db
      .select({ c: count() })
      .from(vendors)
      .where(
        and(eq(vendors.enhancedProfile, true), gte(vendors.enhancedProfileStartedAt, sinceDate))
      ),
    db
      .select({ c: count() })
      .from(vendors)
      .where(
        and(
          eq(vendors.enhancedProfile, true),
          gte(vendors.enhancedProfileStartedAt, priorStartDate),
          lt(vendors.enhancedProfileStartedAt, priorEndDate)
        )
      ),
  ]);
  const payingVendors = paying[0]?.c ?? 0;
  const newInWindow = newRows[0]?.c ?? 0;
  const newInPriorWindow = priorRows[0]?.c ?? 0;
  return {
    payingVendors,
    annualizedUsd: payingVendors * ENHANCED_PROFILE_PRICE_USD,
    newInWindow,
    newInPriorWindow,
    trend: trendOf(newInWindow, newInPriorWindow),
    windowDays: days,
  };
}

// ── Row 2 — Health & action ─────────────────────────────────────────

async function loadSiteHealth(db: Db): Promise<SiteHealthCard> {
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

async function loadIndexNow(db: Db, env: BingEnv, todayStartDate: Date): Promise<IndexNowCard> {
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
  for (const r of todayRows) {
    total += r.c;
    if (r.status === "success") success += r.c;
    else if (r.status === "failure") failures += r.c;
  }

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
    todaySuccessRate: total > 0 ? success / total : 1,
    todayFailures: failures,
    quota,
    quotaError,
  };
}

async function loadRecentErrors(db: Db, sinceDate: Date): Promise<RecentErrorsCard> {
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

// ── Row 3 — Sparklines (always 30d, regardless of window) ───────────

function emptyDailySeries(days: number): SparklinePoint[] {
  const points: SparklinePoint[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    points.push({ date: d.toISOString().slice(0, 10), value: 0 });
  }
  return points;
}

function fillDailySeries(rawByDate: Map<string, number>, days: number): SparklinePoint[] {
  const series = emptyDailySeries(days);
  for (const point of series) {
    point.value = rawByDate.get(point.date) ?? 0;
  }
  return series;
}

async function loadConversionsSparkline(db: Db, sinceDate: Date): Promise<SparklinePoint[]> {
  // strftime expects seconds; columns now store ms (post-0043), so divide by 1000.
  const dayExpr = sql<string>`strftime('%Y-%m-%d', ${analyticsEvents.timestamp} / 1000, 'unixepoch')`;
  const rows = await db
    .select({
      day: dayExpr,
      c: count(),
    })
    .from(analyticsEvents)
    .where(
      and(
        inArray(analyticsEvents.eventName, [...CONVERSION_EVENT_NAMES]),
        gte(analyticsEvents.timestamp, sinceDate)
      )
    )
    .groupBy(dayExpr);

  const byDate = new Map<string, number>();
  for (const r of rows) byDate.set(r.day, r.c);
  return fillDailySeries(byDate, SPARKLINE_DAYS);
}

async function loadPublishingSparkline(db: Db, sinceDate: Date): Promise<SparklinePoint[]> {
  // Publishing activity = successful IndexNow submissions per day. Reflects
  // how often we ship indexable content (event approvals, new venues, etc.)
  // and the cache TTL hides this from GSC for ~24h, so this is the freshest
  // proxy available. strftime expects seconds; columns now store ms (post-0043).
  const dayExpr = sql<string>`strftime('%Y-%m-%d', ${indexnowSubmissions.timestamp} / 1000, 'unixepoch')`;
  const rows = await db
    .select({
      day: dayExpr,
      c: count(),
    })
    .from(indexnowSubmissions)
    .where(
      and(gte(indexnowSubmissions.timestamp, sinceDate), eq(indexnowSubmissions.status, "success"))
    )
    .groupBy(dayExpr);

  const byDate = new Map<string, number>();
  for (const r of rows) byDate.set(r.day, r.c);
  return fillDailySeries(byDate, SPARKLINE_DAYS);
}

// ── Row 4 — Activity feed ──────────────────────────────────────────

async function loadActivity(db: Db, sinceDate: Date): Promise<ActivityEntry[]> {
  const limit = 20;

  const [adminRows, indexnowRows, conversionRows] = await Promise.all([
    db
      .select({
        id: adminActions.id,
        action: adminActions.action,
        actorUserId: adminActions.actorUserId,
        targetType: adminActions.targetType,
        targetId: adminActions.targetId,
        createdAt: adminActions.createdAt,
      })
      .from(adminActions)
      .where(gte(adminActions.createdAt, sinceDate))
      .orderBy(desc(adminActions.createdAt))
      .limit(limit),
    db
      .select({
        id: indexnowSubmissions.id,
        source: indexnowSubmissions.source,
        urls: indexnowSubmissions.urls,
        status: indexnowSubmissions.status,
        timestamp: indexnowSubmissions.timestamp,
      })
      .from(indexnowSubmissions)
      .where(
        and(
          gte(indexnowSubmissions.timestamp, sinceDate),
          inArray(indexnowSubmissions.source, [...HIGH_PRIORITY_INDEXNOW_SOURCES]),
          eq(indexnowSubmissions.status, "success")
        )
      )
      .orderBy(desc(indexnowSubmissions.timestamp))
      .limit(limit),
    db
      .select({
        id: analyticsEvents.id,
        eventName: analyticsEvents.eventName,
        properties: analyticsEvents.properties,
        timestamp: analyticsEvents.timestamp,
      })
      .from(analyticsEvents)
      .where(
        and(
          inArray(analyticsEvents.eventName, [...CONVERSION_EVENT_NAMES]),
          gte(analyticsEvents.timestamp, sinceDate)
        )
      )
      .orderBy(desc(analyticsEvents.timestamp))
      .limit(limit),
  ]);

  const merged: ActivityEntry[] = [];

  for (const r of adminRows) {
    // All three source columns are now ms-epoch Date objects post-0043;
    // .getTime() everywhere, no more dual-format normalization needed.
    merged.push({
      ts: (r.createdAt as Date).getTime(),
      kind: "admin",
      description: `${r.action} on ${r.targetType} ${r.targetId.slice(0, 8)}`,
      actor: r.actorUserId ? r.actorUserId.slice(0, 8) : null,
    });
  }

  for (const r of indexnowRows) {
    let firstUrl: string | null = null;
    try {
      const arr = JSON.parse(r.urls) as string[];
      if (Array.isArray(arr) && arr.length > 0) firstUrl = arr[0];
    } catch {
      // ignore — leave firstUrl null
    }
    merged.push({
      ts: r.timestamp.getTime(),
      kind: "indexnow",
      description: `IndexNow ${r.source}${firstUrl ? ` · ${firstUrl}` : ""}`,
      href: firstUrl ?? undefined,
    });
  }

  for (const r of conversionRows) {
    let slug: string | null = null;
    let url: string | null = null;
    try {
      const props = JSON.parse(r.properties ?? "{}") as {
        eventSlug?: string;
        destinationUrl?: string;
      };
      slug = props.eventSlug ?? null;
      url = props.destinationUrl ?? null;
    } catch {
      // ignore
    }
    const label = r.eventName === "outbound_ticket_click" ? "Ticket click" : "Application click";
    merged.push({
      ts: r.timestamp.getTime(),
      kind: "conversion",
      description: `${label}${slug ? ` · ${slug}` : ""}`,
      href: url ?? undefined,
    });
  }

  merged.sort((a, b) => b.ts - a.ts);
  return merged.slice(0, 10);
}
