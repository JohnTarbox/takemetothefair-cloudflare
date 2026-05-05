/**
 * §6.3 KPI state-machine: compute, classify, persist, prune.
 *
 * Reads each of the 5 executive KPIs from its existing source (GSC, GA4, D1
 * counts, time_to_index_log), classifies it via `classifyKpi`, and appends a
 * row to `kpi_state_history`. Both displayed values and state classification
 * use a 7-day window ending 48h ago — avoids spurious GREEN→YELLOW→GREEN
 * flips during GA4's finalization lag.
 *
 * Triggered every 10 min by the MCP-Worker cron at `*\/10 * * * *`. Pruning
 * to 90d runs on the same fire (cheap; ~5 rows per fire).
 */
import { and, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import {
  adminActions,
  analyticsEvents,
  events,
  kpiStateHistory,
  timeToIndexLog,
  vendors,
} from "@/lib/db/schema";
import { SITEMAP_MIN_COMPLETENESS } from "@takemetothefair/utils";
import { getOrganicSessions, type Ga4Env } from "@/lib/ga4";
import { getSiteSearchQueries, type ScEnv } from "@/lib/search-console";
import { classifyKpi, KPI_NAMES, type KpiName, type KpiState } from "@/lib/kpi-thresholds";

type Db = DrizzleD1Database<typeof schema>;

/** Stable-window offset: classify on 7d ending `STABLE_LAG_DAYS` ago. */
const STABLE_LAG_DAYS = 2;
const STABLE_WINDOW_DAYS = 7;
/** Time-to-index needs at least this many resolved samples in the last 30d
 *  before we'll classify; below this it's INDETERMINATE. */
const MIN_TTI_SAMPLES_30D = 10;

/** Brand-keyword list for brand_share. Mirrors analytics-overview.ts:277. */
const BRAND_KEYWORDS = ["meet me at the fair", "meetmeatthefair", "mmatf", "take me to the fair"];

const CONVERSION_EVENT_NAMES = ["outbound_ticket_click", "outbound_application_click"] as const;

export type KpiValueResult = {
  /** The classifier value, or null when data isn't flowing yet. */
  value: number | null;
  /** Trace metadata persisted to kpi_state_history.meta as JSON. */
  meta: Record<string, unknown>;
};

export type KpiStateRow = {
  id: number;
  kpiName: KpiName;
  computedAt: Date;
  value: number | null;
  state: KpiState;
  stateChangedFromPrevious: boolean;
  firstDetectedAt: Date | null;
  meta: Record<string, unknown> | null;
};

/**
 * Read the 5 KPI values using the stable 48h-old, 7-day window. Returns one
 * entry per KPI; on a per-KPI failure (e.g. GSC config error), value is null
 * and the failure reason lands in meta.
 */
export async function readKpiValues(
  db: Db,
  env: ScEnv & Ga4Env
): Promise<Record<KpiName, KpiValueResult>> {
  const nowMs = Date.now();
  const stableEndMs = nowMs - STABLE_LAG_DAYS * 86400 * 1000;
  const stableStartMs = stableEndMs - STABLE_WINDOW_DAYS * 86400 * 1000;
  const stableStartDate = new Date(stableStartMs);
  const stableEndDate = new Date(stableEndMs);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const [siteCtr, conversionRate, brandShare, sitemapQuality, timeToIndex] = await Promise.all([
    readSiteCtr(env, fmt(stableStartDate), fmt(stableEndDate)),
    readConversionRate(
      db,
      env,
      stableStartDate,
      stableEndDate,
      fmt(stableStartDate),
      fmt(stableEndDate)
    ),
    readBrandShare(env),
    readSitemapQuality(db),
    readTimeToIndex(db),
  ]);

  return {
    site_ctr: siteCtr,
    conversion_rate: conversionRate,
    brand_share: brandShare,
    sitemap_quality: sitemapQuality,
    time_to_index_h: timeToIndex,
  };
}

async function readSiteCtr(
  env: ScEnv,
  startDate: string,
  endDate: string
): Promise<KpiValueResult> {
  try {
    const res = await getSiteSearchQueries(env, {
      rowLimit: 500,
      dateRange: { startDate, endDate },
    });
    const ctr = res.totals.impressions > 0 ? res.totals.clicks / res.totals.impressions : 0;
    return {
      value: ctr,
      meta: {
        clicks: res.totals.clicks,
        impressions: res.totals.impressions,
        window: { startDate, endDate },
      },
    };
  } catch (e) {
    return { value: null, meta: { error: String(e), window: { startDate, endDate } } };
  }
}

async function readConversionRate(
  db: Db,
  env: Ga4Env,
  sinceDate: Date,
  untilDate: Date,
  startDate: string,
  endDate: string
): Promise<KpiValueResult> {
  // Numerator: outbound_ticket_click + outbound_application_click in the
  // 7d stable window. Both bounds are required so the classifier sees the
  // SAME window as the displayed Conversion-rate card (loadConversionRate
  // in analytics-overview.ts) — without `lt(timestamp, untilDate)` the
  // classifier would silently include 2 extra days of events vs. the
  // displayed numerator, and the rates would disagree.
  const [numRow, sessions] = await Promise.all([
    db
      .select({ n: count() })
      .from(analyticsEvents)
      .where(
        and(
          inArray(analyticsEvents.eventName, [...CONVERSION_EVENT_NAMES]),
          gte(analyticsEvents.timestamp, sinceDate),
          lt(analyticsEvents.timestamp, untilDate)
        )
      ),
    getOrganicSessions(env, startDate, endDate),
  ]);
  const numerator = numRow[0]?.n ?? 0;
  if (sessions == null || sessions === 0) {
    return {
      value: null,
      meta: { numerator, sessions, window: { startDate, endDate }, reason: "no_organic_sessions" },
    };
  }
  return {
    value: numerator / sessions,
    meta: { numerator, sessions, window: { startDate, endDate } },
  };
}

async function readBrandShare(env: ScEnv): Promise<KpiValueResult> {
  // GSC default window (last 28d) — brand share is a slow-moving signal so
  // 48h shift isn't material. Mirrors loadBrandVsNonBrand in analytics-overview.ts.
  try {
    const res = await getSiteSearchQueries(env, { rowLimit: 500 });
    let brand = 0;
    let total = 0;
    for (const row of res.queries) {
      const q = row.query.toLowerCase();
      const isBrand = BRAND_KEYWORDS.some((k) => q.includes(k));
      if (isBrand) brand += row.clicks;
      total += row.clicks;
    }
    if (total === 0) {
      return { value: null, meta: { brand, total, reason: "no_clicks" } };
    }
    return { value: brand / total, meta: { brand, total } };
  } catch (e) {
    return { value: null, meta: { error: String(e) } };
  }
}

async function readSitemapQuality(db: Db): Promise<KpiValueResult> {
  // Mirrors loadSitemapQuality in analytics-overview.ts — vendors not
  // soft-deleted + all events, % passing the completeness gate.
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
  const vT = vTotal[0]?.n ?? 0;
  const vP = vPass[0]?.n ?? 0;
  const eT = eTotal[0]?.n ?? 0;
  const eP = ePass[0]?.n ?? 0;
  const total = vT + eT;
  if (total === 0) return { value: null, meta: { reason: "empty_catalog" } };
  return {
    value: (vP + eP) / total,
    meta: {
      pass: vP + eP,
      total,
      vendors: { pass: vP, total: vT },
      events: { pass: eP, total: eT },
      threshold: SITEMAP_MIN_COMPLETENESS,
    },
  };
}

async function readTimeToIndex(db: Db): Promise<KpiValueResult> {
  // Median computed in JS — SQLite has no MEDIAN aggregate. Require at least
  // MIN_TTI_SAMPLES_30D resolved samples in the last 30d before classifying;
  // below that, the median is too noisy and we return INDETERMINATE.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000);
  const rows = await db
    .select({ lagSeconds: timeToIndexLog.lagSeconds })
    .from(timeToIndexLog)
    .where(
      and(
        sql`${timeToIndexLog.lagSeconds} IS NOT NULL`,
        gte(timeToIndexLog.firstCrawlAt, thirtyDaysAgo)
      )
    )
    .orderBy(desc(timeToIndexLog.firstCrawlAt))
    .limit(1000);
  const lags = rows
    .map((r) => r.lagSeconds)
    .filter((n): n is number => typeof n === "number")
    .sort((a, b) => a - b);
  if (lags.length < MIN_TTI_SAMPLES_30D) {
    return {
      value: null,
      meta: {
        samples: lags.length,
        threshold: MIN_TTI_SAMPLES_30D,
        reason: "insufficient_samples",
      },
    };
  }
  const medianSec = lags[Math.floor(lags.length / 2)];
  return {
    value: medianSec / 3600,
    meta: { samples: lags.length, median_seconds: medianSec },
  };
}

/**
 * Pure transition decision: given a current value and the previous-row state,
 * compute the next row's state, the changed-flag, and the carried-forward
 * firstDetectedAt. Extracted from `recomputeKpiStates` so the transition
 * logic is testable without mocking D1.
 */
export function decideStateRow(
  kpi: KpiName,
  value: number | null,
  prev: { state: KpiState; firstDetectedAt: Date | null } | undefined,
  now: Date
): {
  state: KpiState;
  stateChangedFromPrevious: boolean;
  firstDetectedAt: Date;
  isResolution: boolean;
} {
  const state = classifyKpi(kpi, value);
  const changed = !prev || prev.state !== state;
  const firstDetectedAt = changed ? now : (prev?.firstDetectedAt ?? now);
  // A "resolution" is a transition from RED/YELLOW back to GREEN — that's
  // what the admin_actions audit log captures so the trend isn't lost when
  // the action-queue row drops.
  const isResolution =
    changed &&
    state === "GREEN" &&
    prev != null &&
    (prev.state === "RED" || prev.state === "YELLOW");
  return { state, stateChangedFromPrevious: changed, firstDetectedAt, isResolution };
}

/**
 * Recompute all 5 KPI states and append a row per KPI to kpi_state_history.
 * Computes `state_changed_from_previous` and carries forward `firstDetectedAt`
 * across rows of the same state. On state transition to GREEN, writes an
 * `admin_actions` row so the resolution is preserved in the audit log when
 * the action-queue entry disappears.
 */
export async function recomputeKpiStates(
  db: Db,
  env: ScEnv & Ga4Env
): Promise<{ written: number; transitions: number; resolved: number }> {
  const values = await readKpiValues(db, env);

  // Look up the previous row per KPI in one query.
  const prevRows = await db
    .select({
      kpiName: kpiStateHistory.kpiName,
      state: kpiStateHistory.state,
      firstDetectedAt: kpiStateHistory.firstDetectedAt,
      computedAt: kpiStateHistory.computedAt,
    })
    .from(kpiStateHistory)
    .where(sql`${kpiStateHistory.id} IN (SELECT MAX(id) FROM kpi_state_history GROUP BY kpi_name)`);
  const prevByName = new Map(prevRows.map((r) => [r.kpiName as KpiName, r]));

  const now = new Date();
  const insertRows: Array<typeof kpiStateHistory.$inferInsert> = [];
  const auditRows: Array<typeof adminActions.$inferInsert> = [];
  let transitions = 0;
  let resolved = 0;

  for (const kpi of KPI_NAMES) {
    const v = values[kpi];
    const prev = prevByName.get(kpi);
    const decision = decideStateRow(
      kpi,
      v.value,
      prev ? { state: prev.state as KpiState, firstDetectedAt: prev.firstDetectedAt } : undefined,
      now
    );

    insertRows.push({
      kpiName: kpi,
      computedAt: now,
      value: v.value,
      state: decision.state,
      stateChangedFromPrevious: decision.stateChangedFromPrevious ? 1 : 0,
      firstDetectedAt: decision.firstDetectedAt,
      meta: JSON.stringify(v.meta),
    });

    if (decision.stateChangedFromPrevious) transitions += 1;
    if (decision.isResolution && prev) {
      resolved += 1;
      auditRows.push({
        action: "kpi.state_resolved",
        actorUserId: null,
        targetType: "kpi",
        targetId: kpi,
        payloadJson: JSON.stringify({
          kpi,
          previous_state: prev.state,
          new_state: decision.state,
          value: v.value,
        }),
        createdAt: now,
      });
    }
  }

  if (insertRows.length > 0) {
    await db.insert(kpiStateHistory).values(insertRows);
  }
  if (auditRows.length > 0) {
    await db.insert(adminActions).values(auditRows);
  }

  return { written: insertRows.length, transitions, resolved };
}

/**
 * Return the latest row per KPI for the Overview tab to consume. Single
 * SELECT with a subquery for MAX(id) per kpi_name.
 */
export async function getLatestKpiStates(db: Db): Promise<Map<KpiName, KpiStateRow>> {
  const rows = await db
    .select()
    .from(kpiStateHistory)
    .where(sql`${kpiStateHistory.id} IN (SELECT MAX(id) FROM kpi_state_history GROUP BY kpi_name)`);
  const result = new Map<KpiName, KpiStateRow>();
  for (const r of rows) {
    let metaParsed: Record<string, unknown> | null = null;
    if (r.meta) {
      try {
        metaParsed = JSON.parse(r.meta) as Record<string, unknown>;
      } catch {
        metaParsed = null;
      }
    }
    result.set(r.kpiName as KpiName, {
      id: r.id,
      kpiName: r.kpiName as KpiName,
      computedAt: r.computedAt,
      value: r.value,
      state: r.state as KpiState,
      stateChangedFromPrevious: r.stateChangedFromPrevious === 1,
      firstDetectedAt: r.firstDetectedAt,
      meta: metaParsed,
    });
  }
  return result;
}

/**
 * Has this KPI been RED at any point in the last 7 days? Used to suppress
 * P1 entries for YELLOW KPIs that are stabilizing after a RED period.
 */
export async function wasRedInLast7d(db: Db, kpi: KpiName): Promise<boolean> {
  const sinceDate = new Date(Date.now() - 7 * 86400 * 1000);
  const [row] = await db
    .select({ id: kpiStateHistory.id })
    .from(kpiStateHistory)
    .where(
      and(
        eq(kpiStateHistory.kpiName, kpi),
        eq(kpiStateHistory.state, "RED"),
        gte(kpiStateHistory.computedAt, sinceDate)
      )
    )
    .limit(1);
  return row != null;
}

/**
 * Delete kpi_state_history rows older than 90 days. Called from the recompute
 * job — cheap, runs on every fire.
 */
export async function pruneKpiStateHistory(db: Db): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - 90 * 86400 * 1000);
  const res = await db
    .delete(kpiStateHistory)
    .where(lt(kpiStateHistory.computedAt, cutoff))
    .returning({ id: kpiStateHistory.id });
  return { deleted: res.length };
}
