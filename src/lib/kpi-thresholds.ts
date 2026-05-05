/**
 * KPI threshold bands and effort labels for the §6.3 action-threshold model.
 *
 * Five executive KPIs each get a 3-state classification (GREEN / YELLOW / RED),
 * plus INDETERMINATE when the underlying data isn't flowing yet. Thresholds are
 * hardcoded for v1 — moving them to a `kpi_thresholds` D1 table would let us
 * tune without a deploy, but the analyst memo explicitly preferred hardcoded
 * over env vars (too easy to forget in a new environment).
 *
 * Threshold semantics per direction:
 *   higher_better: GREEN if value >= green; RED if value < red; YELLOW otherwise.
 *   lower_better:  GREEN if value <= green; RED if value > red;  YELLOW otherwise.
 *
 * Boundaries are inclusive on the GREEN side, strict on the RED side.
 */
export type KpiName =
  | "site_ctr"
  | "conversion_rate"
  | "brand_share"
  | "sitemap_quality"
  | "time_to_index_h";

export type KpiState = "GREEN" | "YELLOW" | "RED" | "INDETERMINATE" | "STALE";

export type KpiDirection = "higher_better" | "lower_better";

export type KpiThreshold = {
  green: number;
  red: number;
  direction: KpiDirection;
  /** Human-readable target string for UI ("≥ 2.0%", "≤ 24h"). */
  targetLabel: string;
  /** Effort/owner string surfaced in the action queue when this KPI is RED. */
  effort: string;
  /** Brief action description shown under a RED card and in the action queue. */
  actionDescription: string;
  /** Where to send the user from the action-queue entry. */
  href: string;
  /** Friendly card title (matches the existing §10.3 card titles). */
  displayName: string;
  /**
   * Maximum age (seconds) of the underlying data source before the KPI is
   * classified STALE — regardless of value. STALE wins over GREEN/YELLOW/RED
   * because a broken data feed invalidates the value entirely (lesson from
   * the 2026-04-27 → 2026-05-05 silent GA4 outage where conversion rate
   * happily reported 193% as GREEN against a near-empty denominator).
   *
   * SLA per source: GA4 finalization lag is ~24h, so 48h is the practical
   * "still healthy" upper bound; GSC similar; D1 is real-time so 1h means
   * "the catalog hasn't been touched, suspicious"; URL Inspection sweep
   * runs daily so 7d covers the slow-moving time-to-index pipeline.
   */
  staleSlaSeconds: number;
};

const HOURS = 3600;

export const KPI_THRESHOLDS: Record<KpiName, KpiThreshold> = {
  site_ctr: {
    green: 0.02,
    red: 0.01,
    direction: "higher_better",
    targetLabel: "≥ 2.0%",
    effort: "1 dev day",
    actionDescription: "Review event title/description template",
    href: "/admin/recommendations",
    displayName: "Site CTR",
    staleSlaSeconds: 48 * HOURS, // GSC daily refresh + finalization lag
  },
  conversion_rate: {
    green: 0.08,
    red: 0.05,
    direction: "higher_better",
    targetLabel: "≥ 8%",
    effort: "0.5 dev day",
    actionDescription: "Audit content quality; check destination engagement",
    href: "/admin/analytics",
    displayName: "Conversion rate",
    staleSlaSeconds: 48 * HOURS, // GA4 finalization
  },
  brand_share: {
    green: 0.4,
    red: 0.6,
    direction: "lower_better",
    targetLabel: "≤ 40%",
    effort: "Marketing",
    actionDescription: "Expand pillar/cluster pages; non-brand content investment",
    href: "/admin/analytics",
    displayName: "Brand share",
    staleSlaSeconds: 48 * HOURS, // GSC daily refresh
  },
  sitemap_quality: {
    green: 0.75,
    red: 0.6,
    direction: "higher_better",
    targetLabel: "≥ 75%",
    effort: "1 dev day",
    actionDescription: "Raise ingestion quality bar; ship event-side gate",
    href: "/admin/recommendations",
    displayName: "Sitemap quality",
    staleSlaSeconds: 1 * HOURS, // D1 is real-time; 1h = "catalog hasn't moved, suspicious"
  },
  time_to_index_h: {
    green: 24,
    red: 72,
    direction: "lower_better",
    targetLabel: "≤ 24h",
    effort: "0.5 dev day",
    actionDescription: "Review crawl pipeline; check IndexNow throughput",
    href: "/admin/diagnostics",
    displayName: "Time-to-index",
    staleSlaSeconds: 7 * 24 * HOURS, // URL Inspection sweep is daily; 7d covers slow pipeline
  },
};

export const KPI_NAMES: KpiName[] = [
  "site_ctr",
  "conversion_rate",
  "brand_share",
  "sitemap_quality",
  "time_to_index_h",
];

/**
 * Classify a KPI value against its thresholds.
 *
 * Order of precedence:
 *   1. STALE wins if `dataAgeSeconds > staleSlaSeconds` — a broken data feed
 *      invalidates the value entirely; classifying RED/GREEN against bogus
 *      input is the failure mode the §6.3 dashboard had during the GA4
 *      outage (see `feedback_green_with_bogus_inputs.md`).
 *   2. INDETERMINATE if value is null/non-finite (data hasn't accumulated yet).
 *   3. Otherwise GREEN/YELLOW/RED by direction + boundaries.
 *
 * `dataAgeSeconds = null` means "freshness check not applicable / unknown" —
 * classifier skips the STALE branch and proceeds to value-based classification.
 * Use this only when the data source genuinely has no concept of staleness
 * (none of the current 5 KPIs qualify).
 */
export function classifyKpi(
  name: KpiName,
  value: number | null,
  dataAgeSeconds: number | null
): KpiState {
  const t = KPI_THRESHOLDS[name];
  if (dataAgeSeconds != null && dataAgeSeconds > t.staleSlaSeconds) return "STALE";
  if (value == null || !Number.isFinite(value)) return "INDETERMINATE";
  if (t.direction === "higher_better") {
    if (value >= t.green) return "GREEN";
    if (value < t.red) return "RED";
    return "YELLOW";
  }
  // lower_better
  if (value <= t.green) return "GREEN";
  if (value > t.red) return "RED";
  return "YELLOW";
}

/** Format a duration in seconds for STALE messages: "3h", "5d", "27h". */
export function formatStaleAge(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 24 * 3600) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/** Format the action-queue title for a RED/YELLOW KPI breach. */
export function actionTitleForKpi(name: KpiName, value: number | null): string {
  const t = KPI_THRESHOLDS[name];
  return `${t.displayName} is ${formatKpiValue(name, value)} (target ${t.targetLabel})`;
}

function formatKpiValue(name: KpiName, value: number | null): string {
  if (value == null) return "—";
  if (name === "time_to_index_h") return `${value.toFixed(1)}h`;
  // All other KPIs are ratios in [0, 1].
  return `${(value * 100).toFixed(2)}%`;
}
