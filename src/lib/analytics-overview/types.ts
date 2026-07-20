/**
 * Public types + value constants for the /admin/analytics Overview snapshot.
 *
 * These are the cards, deltas, and snapshot shapes consumed by the admin
 * analytics page. No DB logic lives here — only types, the small value
 * constants, and the WindowKey type guard.
 */

import type { BingIndexNowQuota } from "@/lib/bing-webmaster";
import type { KpiName } from "@/lib/kpi-thresholds";
import type { KpiStateRow } from "@/lib/kpi-states";

export const ENHANCED_PROFILE_PRICE_USD = 29;

export type WindowKey = "1d" | "7d" | "30d" | "90d";
export const WINDOW_KEYS: WindowKey[] = ["1d", "7d", "30d", "90d"];

export function isWindowKey(value: string | undefined): value is WindowKey {
  return value === "1d" || value === "7d" || value === "30d" || value === "90d";
}

export type Trend = "up" | "down" | "flat";

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
  todaySuccessRate: number; // 0..1 — over attempts (success+failure); 0 when only deferrals (OPE-243)
  todayFailures: number;
  todayDeferred: number; // OPE-243 — breaker-skipped (paused/latched) rows; deferral != success
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
  // Actionable subset: red items (always urgent) + yellow items in T1/T2
  // tier rules (high-impact opportunities). Excludes T3 yellow which is
  // content-quality noise at scale (~3.5k items). The card surfaces this
  // as the headline number; the raw totalItems goes in the footer.
  actionableCount: number;
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

/**
 * OPE-83 — render-fault health tile. Sourced from the OPE-81 `fault_signatures`
 * ledger (all rows) + a windowed slice of `error_logs`. Every ratio is nullable
 * so a cold ledger (or an un-instrumented metric) renders "—"/"n/a" instead of
 * NaN — same nullable-metric convention as ConversionRateCard.
 */
export type RenderFaultHealthCard = {
  totalSignatures: number;
  openSignatures: number; // status proposed|filed|regressed
  autoDetectedPct: number | null; // signatures with ope_id set / total (pipeline-filed share); null if 0 sigs
  meanTimeToDetectHours: number | null; // avg(filedAt - firstSeen) over filed rows; null if none filed
  serverMessagePct: number | null; // error_logs source='server-render' / all error rows in window; null if 0 rows
  // Dedup collapse: 1 - (distinct signatures / total occurrences summed). The
  // share of raw occurrences the ledger folded away — HIGH is healthy (a hot
  // page's thousands of crashes collapse to one signature). Informative inverse
  // of the design doc's "duplicate-file rate", which is ~0 by construction (the
  // ledger files once per signature). Null if 0 occurrences.
  dedupCollapseRate: number | null;
  recurrenceRate: number | null; // regressed / (done + regressed); null if none ever done
  guardCoveragePct: number | null; // NOT YET INSTRUMENTED → always null (render "n/a")
  windowDays: number;
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

/** OPE-247 — one work queue's drain row for the /admin/analytics tile. */
export type QueueDrainTileRow = {
  queueName: string;
  label: string;
  depth: number;
  inflow7d: number;
  /** null = outflow not yet computable (inbound queue before snapshot history). */
  outflow7d: number | null;
  /** trailing-7d outflow ÷ inflow; null when inflow 0 or outflow unknown. */
  drainRatio7d: number | null;
  frozen: boolean;
};
export type QueueDrainCard = {
  queues: QueueDrainTileRow[];
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
  renderFaultHealth: RenderFaultHealthCard;
  /** OPE-247 — per-queue inflow/outflow/depth/drain-ratio. */
  queueDrain: QueueDrainCard;
  thisWeeksActions: ThisWeeksActionsCard;
  kpiStrip90d: KpiSparklineStrip;
  // §6.3 additions
  accountEngagement: AccountEngagementCard;
  kpiStates: Map<KpiName, KpiStateRow>;
  actionQueue: ActionQueueEntry[];
};

/** OPE-78 — SLA state of an action-queue item vs. its age-in-red threshold.
 *  `red` = breached (== the Move-1 alert trigger); `amber` = approaching;
 *  `green` = within window; `none` = no first-detected stamp (e.g. rec rules). */
export type ActionQueueSla = "red" | "amber" | "green" | "none";

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
  /** OPE-78 — hours the item has been red (now − firstDetectedAt); null when
   *  there is no first-detected stamp. Exposed so Move 1 (alert) + Move 2
   *  (auto-file) read one field instead of each recomputing age. */
  hoursInRed: number | null;
  /** OPE-78 — SLA chip state derived from hoursInRed vs the per-priority
   *  threshold (same thresholds Move 1 alerts on). */
  slaStatus: ActionQueueSla;
};
