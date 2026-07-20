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
 *
 * This file is the public entry point: it orchestrates the per-domain loaders
 * (under ./analytics-overview/) into a single snapshot and re-exports every
 * public type/constant so `@/lib/analytics-overview` stays the stable import
 * path for consumers.
 */

import { getLatestKpiStates } from "@/lib/kpi-states";
import { type Ga4Env } from "@/lib/ga4";
import { type BingEnv } from "@/lib/bing-webmaster";
import { type ScEnv } from "@/lib/search-console";
import { SPARKLINE_DAYS, windowDays, type Db } from "./analytics-overview/shared";
import {
  loadBrandVsNonBrand,
  loadKpiStrip90d,
  loadSearchVisibility,
  loadSearchVisibilitySparkline,
  loadSiteCtr,
} from "./analytics-overview/search-visibility";
import {
  loadConversionRate,
  loadConversions,
  loadConversionsSparkline,
} from "./analytics-overview/conversions";
import { loadCatalogGrowth, loadEnhancedProfileRevenue } from "./analytics-overview/catalog";
import { loadBlogCoverage, loadRecommendationsSummary } from "./analytics-overview/content";
import { loadRenderFaultHealth } from "./analytics-overview/fault-health";
import { loadQueueDrain } from "./analytics-overview/queue-drain";
import { loadHeartbeat } from "./heartbeat";
import {
  loadIndexNow,
  loadRecentErrors,
  loadSiteHealth,
  loadSitemapQuality,
  loadTimeToIndex,
} from "./analytics-overview/health";
import {
  loadAccountEngagement,
  loadActionQueue,
  loadActivity,
  loadPublishingSparkline,
  loadThisWeeksActions,
} from "./analytics-overview/activity";
import type { OverviewSnapshot, WindowKey } from "./analytics-overview/types";

export * from "./analytics-overview/types";

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
    renderFaultHealth,
    queueDrain,
    heartbeat,
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
    loadRenderFaultHealth(db, days),
    loadQueueDrain(db),
    loadHeartbeat(db),
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
    renderFaultHealth,
    queueDrain,
    heartbeat,
    thisWeeksActions,
    kpiStrip90d,
    accountEngagement,
    kpiStates,
    actionQueue,
  };
}
