/**
 * Data aggregation for the /admin/analytics Overview triage dashboard.
 *
 * Consolidates signals from multiple existing sources (GSC, D1 analytics_events,
 * indexnow_submissions, error_logs, admin_actions, vendors/events/venues counts,
 * Site Health) into a single snapshot for at-a-glance triage. Deeper analysis
 * lives in the per-source tabs and the GA4 sub-route.
 *
 * Timestamp note: post-0043 + 0045, every operational timestamp column uses
 * Drizzle `mode: "timestamp"` which stores SECONDS-epoch (not ms — that's
 * `mode: "timestamp_ms"`). Reads/writes via Date objects, Drizzle handles
 * the conversion. .getTime() returns ms (browser-side); the activity feed
 * uses ms internally for sort/render.
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
  kpiStateHistory,
  recommendationRules,
  timeToIndexLog,
  userFavorites,
  vendors,
  venues,
} from "@/lib/db/schema";
import { getOrganicSessions, type Ga4Env } from "@/lib/ga4";
import { getLatestKpiStates, type KpiStateRow } from "@/lib/kpi-states";
import { tierFor } from "@/lib/recommendations/tiers";
import {
  KPI_THRESHOLDS,
  actionTitleForKpi,
  formatStaleAge,
  type KpiName,
} from "@/lib/kpi-thresholds";
import { SITEMAP_MIN_COMPLETENESS } from "@takemetothefair/utils";
import {
  BingApiError,
  BingConfigError,
  getIndexNowQuota,
  getQueryStats,
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
  | {
      ok: true;
      current: number;
      previous: number;
      trend: Trend;
      windowDays: number;
      // BWT companion clicks. Bing's API only exposes aggregate query stats
      // (no day-windowed totals), so we surface BWT clicks as a footer hint
      // rather than fold them into the day-bucketed GSC trend. null when
      // BWT is misconfigured or returned an error — non-fatal, the GSC
      // headline still renders.
      bingTotal: number | null;
    }
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

// §10.3 widgets ────────────────────────────────────────────────

export type SiteCtrCard =
  | {
      ok: true;
      clicks: number;
      impressions: number;
      ctr: number;
      trend: Trend;
      previousCtr: number;
    }
  | { ok: false; reason: string };

/**
 * §6.3 conversion rate: outbound ticket/application clicks per organic
 * search session. Numerator is the same `analyticsEvents` count the
 * row-1 "Conversions" card shows (CONVERSION_EVENT_NAMES); denominator is
 * GA4 sessions filtered to `sessionMedium='organic'`. Window ends 48h ago
 * to avoid GA4-finalization-lag flips.
 *
 * `sessions` is null when GA4 returns an error or no organic traffic — in
 * that case `rate` is also null and the card renders "—".
 */
export type ConversionRateCard = {
  conversions: number;
  sessions: number | null;
  rate: number | null;
  windowDays: number;
  /** ISO date string for the window end so the tooltip can show the lag. */
  windowEndDate: string;
};

/**
 * Account engagement rate (renamed from the old multi-numerator "conversion
 * rate"). Tracks the Enhanced-Profile funnel signal: vendor-claim completions
 * + event favorites + contact-form clicks, divided by total first-party
 * analytics events in the window.
 */
export type AccountEngagementCard = {
  signals: number;
  sessions: number;
  rate: number;
  windowDays: number;
  breakdown: { vendor_claims: number; event_favorites: number; contact_clicks: number };
};

/**
 * Brand vs non-brand split. Brand-keyword list is configurable but defaults
 * to the variants of the site name. % is by clicks (impressions also tracked).
 */
export type BrandVsNonBrandCard =
  | {
      ok: true;
      brand_clicks: number;
      brand_impressions: number;
      non_brand_clicks: number;
      non_brand_impressions: number;
      brand_share: number; // 0..1
      windowDays: number;
    }
  | { ok: false; reason: string };

/** Sitemap quality ratio: rows passing the completeness gate / total. */
export type SitemapQualityCard = {
  vendors: { pass: number; total: number };
  events: { pass: number; total: number };
  overall_pass_rate: number; // 0..1
  threshold: number;
};

/** Time-to-index summary computed from time_to_index_log. */
export type TimeToIndexCard = {
  resolved: number;
  unresolved: number;
  median_seconds: number | null;
  p90_seconds: number | null;
  avg_seconds: number | null;
};

/** This week's actions: last 7 days of admin_actions ordered by recency. */
export type ThisWeeksActionsCard = {
  count: number;
  actions: Array<{
    action: string;
    actorUserId: string | null;
    targetType: string;
    targetId: string;
    createdAt: number; // ms-epoch
  }>;
};

/** 90-day per-KPI mini sparkline strip. */
export type KpiSparklineStrip = {
  searchVisibility: SparklinePoint[];
  conversions: SparklinePoint[];
  publishing: SparklinePoint[];
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
  // §10.3 additions
  siteCtr: SiteCtrCard;
  conversionRate: ConversionRateCard;
  brandVsNonBrand: BrandVsNonBrandCard;
  sitemapQuality: SitemapQualityCard;
  timeToIndex: TimeToIndexCard;
  thisWeeksActions: ThisWeeksActionsCard;
  kpiStrip90d: KpiSparklineStrip;
  // §6.3 additions
  accountEngagement: AccountEngagementCard;
  kpiStates: Map<KpiName, KpiStateRow>;
  actionQueue: ActionQueueEntry[];
};

/** §6.3 action-queue entry — one row in the prioritized action panel. */
export type ActionQueueEntry = {
  priority: "P0" | "P1";
  source: "kpi" | "recommendation";
  title: string;
  effort: string;
  href: string;
  /** ISO date string for the "first detected" stamp (KPI entries only). */
  firstDetectedAt: string | null;
  /** KPI name when source='kpi'; rule key when source='recommendation'. */
  refKey: string;
};

/**
 * §10.3 brand-keyword list. Anything containing one of these substrings
 * (case-insensitive) counts as a brand query in the brand-vs-non-brand split.
 */
const BRAND_KEYWORDS = ["meet me at the fair", "meetmeatthefair", "mmatf", "take me to the fair"];

const HIGH_PRIORITY_INDEXNOW_SOURCES = ["venue.create", "vendor.create", "event.approve"] as const;
const CONVERSION_EVENT_NAMES = ["outbound_ticket_click", "outbound_application_click"] as const;
const SPARKLINE_DAYS = 30;

export async function loadOverviewSnapshot(
  db: Db,
  env: ScEnv & BingEnv & Ga4Env,
  window: WindowKey
): Promise<OverviewSnapshot> {
  // All windows expressed as Date objects now that every operational table
  // uses Drizzle mode:"timestamp" (seconds-epoch in storage; reads/writes via Date)
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

  const lastWeekDate = new Date(nowMs - 7 * 86400 * 1000);

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
    siteCtr,
    conversionRate,
    brandVsNonBrand,
    sitemapQuality,
    timeToIndex,
    thisWeeksActions,
    kpiStrip90d,
    accountEngagement,
    kpiStates,
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
    loadSiteCtr(env, days),
    loadConversionRate(db, env, 7),
    loadBrandVsNonBrand(env, days),
    loadSitemapQuality(db),
    loadTimeToIndex(db),
    loadThisWeeksActions(db, lastWeekDate),
    loadKpiStrip90d(db, env),
    loadAccountEngagement(db, sinceDate, days),
    getLatestKpiStates(db),
  ]);

  // Action queue is derived after the latest KPI states + tier-1 rec counts
  // are known. Cheap (1-2 SELECTs); not parallelized to keep the dependency
  // order obvious.
  const actionQueue = await loadActionQueue(db, kpiStates);

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
    siteCtr,
    conversionRate,
    brandVsNonBrand,
    sitemapQuality,
    timeToIndex,
    thisWeeksActions,
    kpiStrip90d,
    accountEngagement,
    kpiStates,
    actionQueue,
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

async function loadSearchVisibility(
  env: ScEnv & BingEnv,
  days: number
): Promise<SearchVisibilityCard> {
  // GSC supports 1d/7d/28d/30d/90d ranges; map non-preset windows to a custom range.
  // The headline is GSC-only (Google's API gives day-bucketed totals); BWT clicks
  // are added as a footer hint via getQueryStats() — Bing's API doesn't expose a
  // windowable totals endpoint, so combining 7d-GSC + lifetime-BWT into a single
  // number would mislead. Surfacing both honestly fixes the analyst's complaint
  // that "-100%" reads as catastrophic when Bing is delivering ~28 clicks fine.
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

    // BWT companion: best-effort. A failure here doesn't sink the whole card —
    // the GSC headline is the load-bearing signal.
    let bingTotal: number | null = null;
    try {
      const bingRows = await getQueryStats(env);
      bingTotal = bingRows.reduce((sum, row) => sum + row.clicks, 0);
    } catch (e) {
      if (!(e instanceof BingApiError) && !(e instanceof BingConfigError)) {
        // Unexpected — let it surface in logs but don't break the page.
        console.warn("[search-visibility] BWT companion failed:", e);
      }
    }

    return {
      ok: true,
      current,
      previous,
      trend: trendOf(current, previous),
      windowDays: days,
      bingTotal,
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
  // strftime expects seconds; columns store seconds (mode:"timestamp").
  const dayExpr = sql<string>`strftime('%Y-%m-%d', ${analyticsEvents.timestamp}, 'unixepoch')`;
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
  // proxy available. strftime expects seconds; columns store seconds.
  const dayExpr = sql<string>`strftime('%Y-%m-%d', ${indexnowSubmissions.timestamp}, 'unixepoch')`;
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
    // All three source columns are Date objects (Drizzle mode:"timestamp" reads as Date);
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

// §10.3 loaders ─────────────────────────────────────────────────

async function loadSiteCtr(env: ScEnv, days: number): Promise<SiteCtrCard> {
  // Prior period of equal length, immediately preceding.
  const today = new Date();
  const startCurr = new Date(today.getTime() - days * 86400 * 1000);
  const startPrev = new Date(today.getTime() - 2 * days * 86400 * 1000);
  const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
  try {
    const [curr, prev] = await Promise.all([
      getSiteSearchQueries(env, {
        rowLimit: 500,
        dateRange: { startDate: fmtDate(startCurr), endDate: fmtDate(today) },
      }),
      getSiteSearchQueries(env, {
        rowLimit: 500,
        dateRange: { startDate: fmtDate(startPrev), endDate: fmtDate(startCurr) },
      }),
    ]);
    const ctr = curr.totals.impressions > 0 ? curr.totals.clicks / curr.totals.impressions : 0;
    const prevCtr = prev.totals.impressions > 0 ? prev.totals.clicks / prev.totals.impressions : 0;
    return {
      ok: true,
      clicks: curr.totals.clicks,
      impressions: curr.totals.impressions,
      ctr,
      previousCtr: prevCtr,
      trend: trendOf(ctr, prevCtr),
    };
  } catch (e) {
    if (e instanceof ScConfigError || e instanceof ScApiError) {
      return { ok: false, reason: e.message };
    }
    throw e;
  }
}

async function loadConversionRate(db: Db, env: Ga4Env, days: number): Promise<ConversionRateCard> {
  // §6.3 definition: outbound_ticket_click count / GA4 organic sessions, in
  // the 7d window ending 48h ago (matches the state classifier so the card
  // and the badge agree). Numerator reuses CONVERSION_EVENT_NAMES — same
  // source as the row-1 "Conversions" card.
  const STABLE_LAG_DAYS = 2;
  const nowMs = Date.now();
  const stableEndMs = nowMs - STABLE_LAG_DAYS * 86400 * 1000;
  const stableStartMs = stableEndMs - days * 86400 * 1000;
  const stableStartDate = new Date(stableStartMs);
  const stableEndDate = new Date(stableEndMs);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const [numRow, sessions] = await Promise.all([
    db
      .select({ n: count() })
      .from(analyticsEvents)
      .where(
        and(
          inArray(analyticsEvents.eventName, [...CONVERSION_EVENT_NAMES]),
          gte(analyticsEvents.timestamp, stableStartDate),
          lt(analyticsEvents.timestamp, stableEndDate)
        )
      ),
    getOrganicSessions(env, fmt(stableStartDate), fmt(stableEndDate)),
  ]);
  const conversions = numRow[0]?.n ?? 0;
  const rate = sessions != null && sessions > 0 ? conversions / sessions : null;
  return {
    conversions,
    sessions,
    rate,
    windowDays: days,
    windowEndDate: fmt(stableEndDate),
  };
}

async function loadAccountEngagement(
  db: Db,
  sinceDate: Date,
  days: number
): Promise<AccountEngagementCard> {
  // Renamed from the old multi-numerator "conversion rate". Tracks Enhanced
  // Profile / engagement funnel: claims + event favorites + contact clicks
  // per first-party analytics event in the window.
  const [claimsRow, favRow, contactRow, sessionRow] = await Promise.all([
    db
      .select({ n: count() })
      .from(adminActions)
      .where(
        and(
          eq(adminActions.action, "vendor.claim_self_serve"),
          gte(adminActions.createdAt, sinceDate)
        )
      ),
    db
      .select({ n: count() })
      .from(userFavorites)
      .where(
        and(eq(userFavorites.favoritableType, "EVENT"), gte(userFavorites.createdAt, sinceDate))
      ),
    db
      .select({ n: count() })
      .from(analyticsEvents)
      .where(
        and(
          eq(analyticsEvents.eventName, "outbound_contact_click"),
          gte(analyticsEvents.timestamp, sinceDate)
        )
      ),
    db
      .select({ n: count() })
      .from(analyticsEvents)
      .where(gte(analyticsEvents.timestamp, sinceDate)),
  ]);
  const vendor_claims = claimsRow[0]?.n ?? 0;
  const event_favorites = favRow[0]?.n ?? 0;
  const contact_clicks = contactRow[0]?.n ?? 0;
  const signals = vendor_claims + event_favorites + contact_clicks;
  const sessions = sessionRow[0]?.n ?? 0;
  const rate = sessions > 0 ? signals / sessions : 0;
  return {
    signals,
    sessions,
    rate,
    windowDays: days,
    breakdown: { vendor_claims, event_favorites, contact_clicks },
  };
}

async function loadBrandVsNonBrand(env: ScEnv, days: number): Promise<BrandVsNonBrandCard> {
  // Honor the dashboard window. Without this, the card always read 28d
  // (getSiteSearchQueries default), creating the analyst-flagged
  // discrepancy where SearchVisibility shows 25 clicks @ 7d but
  // brand+non-brand summed to 53 clicks @ 28d on the same page.
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
          const today = new Date();
          const start = new Date(today.getTime() - days * 86400 * 1000);
          const fmt = (d: Date) => d.toISOString().slice(0, 10);
          return { startDate: fmt(start), endDate: fmt(today) };
        })();
    const result = await getSiteSearchQueries(env, { rowLimit: 500, dateRange });
    let brand_clicks = 0;
    let brand_impressions = 0;
    let non_brand_clicks = 0;
    let non_brand_impressions = 0;
    for (const row of result.queries) {
      const q = row.query.toLowerCase();
      const isBrand = BRAND_KEYWORDS.some((k) => q.includes(k));
      if (isBrand) {
        brand_clicks += row.clicks;
        brand_impressions += row.impressions;
      } else {
        non_brand_clicks += row.clicks;
        non_brand_impressions += row.impressions;
      }
    }
    const total_clicks = brand_clicks + non_brand_clicks;
    return {
      ok: true,
      brand_clicks,
      brand_impressions,
      non_brand_clicks,
      non_brand_impressions,
      brand_share: total_clicks > 0 ? brand_clicks / total_clicks : 0,
      windowDays: days,
    };
  } catch (e) {
    if (e instanceof ScConfigError || e instanceof ScApiError) {
      return { ok: false, reason: e.message };
    }
    throw e;
  }
}

async function loadSitemapQuality(db: Db): Promise<SitemapQualityCard> {
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

async function loadTimeToIndex(db: Db): Promise<TimeToIndexCard> {
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

async function loadThisWeeksActions(db: Db, sinceDate: Date): Promise<ThisWeeksActionsCard> {
  const rows = await db
    .select({
      action: adminActions.action,
      actorUserId: adminActions.actorUserId,
      targetType: adminActions.targetType,
      targetId: adminActions.targetId,
      createdAt: adminActions.createdAt,
    })
    .from(adminActions)
    .where(gte(adminActions.createdAt, sinceDate))
    .orderBy(desc(adminActions.createdAt))
    .limit(20);
  const [countRow] = await db
    .select({ n: count() })
    .from(adminActions)
    .where(gte(adminActions.createdAt, sinceDate));
  return {
    count: countRow?.n ?? 0,
    actions: rows.map((r) => ({
      action: r.action,
      actorUserId: r.actorUserId,
      targetType: r.targetType,
      targetId: r.targetId,
      createdAt: r.createdAt.getTime(),
    })),
  };
}

/**
 * §6.3 action queue. Derives a prioritized list of P0/P1 entries from the
 * latest KPI states + Tier-1 recommendation rules with affected_count >= 50.
 *
 * P0: each KPI in RED → one entry per KPI (KPIs that have been RED for many
 *     days still surface, but `firstDetectedAt` makes the staleness visible).
 * P1: each KPI in YELLOW that wasn't RED any time in the last 7 days. Once
 *     a RED→YELLOW transition stabilizes for a week, it re-enters the queue
 *     so the team is reminded to keep pushing it back to GREEN.
 * P1: each Tier-1 recommendation rule with totalMatchCount >= 50.
 *
 * Auto-resolution: when a KPI returns to GREEN, the recompute job writes a
 * `kpi.state_resolved` row to admin_actions; this loader simply omits the
 * GREEN/INDETERMINATE KPI from the queue. The Recent Activity panel surfaces
 * the resolution from admin_actions.
 */
const TIER_1_REC_AFFECTED_THRESHOLD = 50;

async function loadActionQueue(
  db: Db,
  kpiStates: Map<KpiName, KpiStateRow>
): Promise<ActionQueueEntry[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000);
  const [redInLast7d, hotRecs] = await Promise.all([
    // One query that lists which KPIs were RED at any point in the last 7d.
    // Used to suppress YELLOW→P1 entries for KPIs that just stabilized.
    db
      .selectDistinct({ kpiName: kpiStateHistory.kpiName })
      .from(kpiStateHistory)
      .where(and(eq(kpiStateHistory.state, "RED"), gte(kpiStateHistory.computedAt, sevenDaysAgo))),
    // Tier-1 recommendation rules with >= 50 affected items.
    db
      .select({
        ruleKey: recommendationRules.ruleKey,
        title: recommendationRules.title,
        totalMatchCount: recommendationRules.totalMatchCount,
        enabled: recommendationRules.enabled,
      })
      .from(recommendationRules)
      .where(
        and(
          eq(recommendationRules.enabled, true),
          gte(recommendationRules.totalMatchCount, TIER_1_REC_AFFECTED_THRESHOLD)
        )
      ),
  ]);
  const redRecently = new Set(redInLast7d.map((r) => r.kpiName));

  const entries: ActionQueueEntry[] = [];

  // Stable KPI ordering — matches KPI_NAMES so the queue doesn't reshuffle
  // visually as states flip between fires.
  for (const [kpi, row] of kpiStates) {
    const t = KPI_THRESHOLDS[kpi];
    if (row.state === "STALE") {
      // STALE = data feed is broken. Surface as P0 with a "fix the source"
      // prompt — broken data invalidates GREEN/YELLOW/RED entirely.
      const meta = row.meta as { dataAgeSeconds?: number } | null;
      const ageSec = meta?.dataAgeSeconds;
      const ageLabel = typeof ageSec === "number" ? formatStaleAge(ageSec) : "unknown";
      entries.push({
        priority: "P0",
        source: "kpi",
        title: `${t.displayName} data feed stale (${ageLabel})`,
        effort: "Investigate data source",
        href: t.href,
        firstDetectedAt: row.firstDetectedAt?.toISOString() ?? null,
        refKey: kpi,
      });
    } else if (row.state === "RED") {
      entries.push({
        priority: "P0",
        source: "kpi",
        title: actionTitleForKpi(kpi, row.value),
        effort: t.effort,
        href: t.href,
        firstDetectedAt: row.firstDetectedAt?.toISOString() ?? null,
        refKey: kpi,
      });
    } else if (row.state === "YELLOW" && !redRecently.has(kpi)) {
      entries.push({
        priority: "P1",
        source: "kpi",
        title: actionTitleForKpi(kpi, row.value),
        effort: t.effort,
        href: t.href,
        firstDetectedAt: row.firstDetectedAt?.toISOString() ?? null,
        refKey: kpi,
      });
    }
  }

  for (const rule of hotRecs) {
    if (tierFor(rule.ruleKey) !== "T1") continue;
    entries.push({
      priority: "P1",
      source: "recommendation",
      title: `Activate ${rule.title}: ${rule.totalMatchCount ?? 0} affected`,
      effort: "Marketing / Ops",
      href: `/admin/recommendations`,
      firstDetectedAt: null,
      refKey: rule.ruleKey,
    });
  }

  // P0 first, then P1; within priority KPI entries before recommendation entries.
  entries.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority === "P0" ? -1 : 1;
    if (a.source !== b.source) return a.source === "kpi" ? -1 : 1;
    return a.refKey.localeCompare(b.refKey);
  });
  return entries;
}

async function loadKpiStrip90d(db: Db, env: ScEnv): Promise<KpiSparklineStrip> {
  // 90-day sparklines for the three top KPIs. Reuses the 30-day loaders
  // by passing a deeper sinceDate; GSC daily clicks call uses days=90.
  const since90 = new Date(Date.now() - 90 * 86400 * 1000);
  const [searchVisibility, conversions, publishing] = await Promise.all([
    (async () => {
      try {
        const rows = await getDailyClicks(env, { days: 90 });
        const byDate = new Map<string, number>();
        for (const r of rows) byDate.set(r.date, r.clicks);
        return fillDailySeries(byDate, 90);
      } catch (e) {
        if (e instanceof ScConfigError || e instanceof ScApiError) return emptyDailySeries(90);
        throw e;
      }
    })(),
    loadConversionsSparklineDays(db, since90, 90),
    loadPublishingSparklineDays(db, since90, 90),
  ]);
  return { searchVisibility, conversions, publishing };
}

// 90-day variants of the existing 30-day sparkline loaders. Same SQL shape
// but parameterized on the bucket count so we don't duplicate the gather.
async function loadConversionsSparklineDays(
  db: Db,
  sinceDate: Date,
  days: number
): Promise<SparklinePoint[]> {
  const rows = await db
    .select({
      date: sql<string>`strftime('%Y-%m-%d', ${analyticsEvents.timestamp}, 'unixepoch')`,
      n: count(),
    })
    .from(analyticsEvents)
    .where(
      and(
        inArray(analyticsEvents.eventName, [...CONVERSION_EVENT_NAMES]),
        gte(analyticsEvents.timestamp, sinceDate)
      )
    )
    .groupBy(sql`strftime('%Y-%m-%d', ${analyticsEvents.timestamp}, 'unixepoch')`);
  const byDate = new Map<string, number>();
  for (const r of rows) byDate.set(r.date, r.n);
  return fillDailySeries(byDate, days);
}

async function loadPublishingSparklineDays(
  db: Db,
  sinceDate: Date,
  days: number
): Promise<SparklinePoint[]> {
  const rows = await db
    .select({
      date: sql<string>`strftime('%Y-%m-%d', ${indexnowSubmissions.timestamp}, 'unixepoch')`,
      n: count(),
    })
    .from(indexnowSubmissions)
    .where(
      and(eq(indexnowSubmissions.status, "success"), gte(indexnowSubmissions.timestamp, sinceDate))
    )
    .groupBy(sql`strftime('%Y-%m-%d', ${indexnowSubmissions.timestamp}, 'unixepoch')`);
  const byDate = new Map<string, number>();
  for (const r of rows) byDate.set(r.date, r.n);
  return fillDailySeries(byDate, days);
}
