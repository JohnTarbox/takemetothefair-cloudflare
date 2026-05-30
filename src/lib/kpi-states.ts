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
import { getMaxGa4DateWithUsers, getOrganicSessions, type Ga4Env } from "@/lib/ga4";
import { getMaxGscDataDate, getSiteSearchQueries, type ScEnv } from "@/lib/search-console";
import { classifyKpi, KPI_NAMES, type KpiName, type KpiState } from "@/lib/kpi-thresholds";
import { dispatchKpiAlert } from "@/lib/kpi-alerts";

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
  /**
   * Age of the underlying data source in seconds. Drives STALE classification:
   * if `dataAgeSeconds > thresholds.staleSlaSeconds`, the KPI is STALE
   * regardless of value. `null` means "we couldn't determine freshness"
   * (e.g. API error reading the data source) — treated as STALE since
   * we can't prove the feed is alive.
   */
  dataAgeSeconds: number | null;
  /** Trace metadata persisted to kpi_state_history.meta as JSON. */
  meta: Record<string, unknown>;
};

/** Convert a YYYY-MM-DD date (or null) to seconds-since-now. */
function ageSecondsFromIsoDate(isoDate: string | null): number | null {
  if (!isoDate) return null;
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

/** Convert a Date instant (or null) to seconds-since-now. */
function ageSecondsFromDate(d: Date | null | undefined): number | null {
  if (!d) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
}

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

  // Probe each external data source's freshest date once. Both site_ctr and
  // brand_share share the GSC signal — single API call, two consumers.
  // Conversion-rate's freshness comes from GA4 (the staleness-sensitive
  // denominator); first-party numerator is in D1 and assumed fresh.
  const [gscMaxDate, ga4MaxDate] = await Promise.all([
    getMaxGscDataDate(env),
    getMaxGa4DateWithUsers(env),
  ]);

  const [siteCtr, conversionRate, brandShare, sitemapQuality, timeToIndex] = await Promise.all([
    readSiteCtr(env, fmt(stableStartDate), fmt(stableEndDate), gscMaxDate),
    readConversionRate(
      db,
      env,
      stableStartDate,
      stableEndDate,
      fmt(stableStartDate),
      fmt(stableEndDate),
      ga4MaxDate
    ),
    readBrandShare(env, gscMaxDate),
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
  endDate: string,
  gscMaxDate: string | null
): Promise<KpiValueResult> {
  try {
    const res = await getSiteSearchQueries(env, {
      rowLimit: 500,
      dateRange: { startDate, endDate },
    });
    const ctr = res.totals.impressions > 0 ? res.totals.clicks / res.totals.impressions : 0;
    return {
      value: ctr,
      dataAgeSeconds: ageSecondsFromIsoDate(gscMaxDate),
      meta: {
        clicks: res.totals.clicks,
        impressions: res.totals.impressions,
        window: { startDate, endDate },
        gscMaxDate,
      },
    };
  } catch (e) {
    return {
      value: null,
      dataAgeSeconds: ageSecondsFromIsoDate(gscMaxDate),
      meta: { error: String(e), window: { startDate, endDate }, gscMaxDate },
    };
  }
}

async function readConversionRate(
  db: Db,
  env: Ga4Env,
  sinceDate: Date,
  untilDate: Date,
  startDate: string,
  endDate: string,
  ga4MaxDate: string | null
): Promise<KpiValueResult> {
  // Numerator: outbound_ticket_click + outbound_application_click in the
  // 7d stable window. Both bounds are required so the classifier sees the
  // SAME window as the displayed Conversion-rate card (loadConversionRate
  // in analytics-overview.ts) — without `lt(timestamp, untilDate)` the
  // classifier would silently include 2 extra days of events vs. the
  // displayed numerator, and the rates would disagree.
  //
  // Staleness signal: GA4 freshness. The first-party analyticsEvents feed
  // keeps flowing during a GA4 outage (it's our own beacon), so the meaningful
  // "is this metric trustworthy" axis is GA4. ga4MaxDate is the most recent
  // date GA4 reported users > 0; null means GA4 returned no data in 7d.
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
  const dataAgeSeconds = ageSecondsFromIsoDate(ga4MaxDate);
  if (sessions == null || sessions === 0) {
    return {
      value: null,
      dataAgeSeconds,
      meta: {
        numerator,
        sessions,
        window: { startDate, endDate },
        ga4MaxDate,
        reason: "no_organic_sessions",
      },
    };
  }
  return {
    value: numerator / sessions,
    dataAgeSeconds,
    meta: { numerator, sessions, window: { startDate, endDate }, ga4MaxDate },
  };
}

async function readBrandShare(env: ScEnv, gscMaxDate: string | null): Promise<KpiValueResult> {
  // GSC default window (last 28d) — brand share is a slow-moving signal so
  // 48h shift isn't material. Mirrors loadBrandVsNonBrand in analytics-overview.ts.
  // Staleness signal shared with site_ctr (same GSC source).
  const dataAgeSeconds = ageSecondsFromIsoDate(gscMaxDate);
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
      return {
        value: null,
        dataAgeSeconds,
        meta: { brand, total, gscMaxDate, reason: "no_clicks" },
      };
    }
    return { value: brand / total, dataAgeSeconds, meta: { brand, total, gscMaxDate } };
  } catch (e) {
    return { value: null, dataAgeSeconds, meta: { error: String(e), gscMaxDate } };
  }
}

async function readSitemapQuality(db: Db): Promise<KpiValueResult> {
  // Mirrors loadSitemapQuality in analytics-overview.ts — vendors not
  // soft-deleted + all events, % passing the completeness gate.
  //
  // Staleness signal: D1 is real-time; we use max(updated_at) across both
  // tables to detect "the catalog hasn't moved" (true outage). 1h SLA
  // means a tightly-managed catalog should never show STALE in practice.
  const [vTotal, vPass, eTotal, ePass, vMax, eMax] = await Promise.all([
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
    db
      .select({ ts: sql<number | null>`max(${vendors.updatedAt})` })
      .from(vendors)
      .where(sql`${vendors.deletedAt} IS NULL`),
    db.select({ ts: sql<number | null>`max(${events.updatedAt})` }).from(events),
  ]);
  const vT = vTotal[0]?.n ?? 0;
  const vP = vPass[0]?.n ?? 0;
  const eT = eTotal[0]?.n ?? 0;
  const eP = ePass[0]?.n ?? 0;
  // updatedAt is stored seconds-epoch (Drizzle mode:"timestamp"). Compare
  // raw seconds, then convert to a Date for the helper.
  //
  // Fallback: many old vendors/events rows have NULL updated_at (inserted
  // via raw SQL or pre-Drizzle migrations that didn't run the $defaultFn).
  // If max() returns null but the catalog DOES have rows, treat the data
  // as fresh (ageSeconds=0) — absence of updated_at metadata isn't evidence
  // the feed is broken. Only when total === 0 (genuinely empty catalog) do
  // we let dataAgeSeconds bubble up as null → INDETERMINATE.
  const vMaxSec = vMax[0]?.ts ?? null;
  const eMaxSec = eMax[0]?.ts ?? null;
  const maxSec =
    vMaxSec != null && eMaxSec != null ? Math.max(vMaxSec, eMaxSec) : (vMaxSec ?? eMaxSec);
  const total = vT + eT;
  const dataAgeSeconds =
    maxSec != null ? ageSecondsFromDate(new Date(maxSec * 1000)) : total > 0 ? 0 : null;
  if (total === 0) return { value: null, dataAgeSeconds, meta: { reason: "empty_catalog" } };
  return {
    value: (vP + eP) / total,
    dataAgeSeconds,
    meta: {
      pass: vP + eP,
      total,
      vendors: { pass: vP, total: vT },
      events: { pass: eP, total: eT },
      threshold: SITEMAP_MIN_COMPLETENESS,
      catalogMaxUpdatedAt: maxSec,
    },
  };
}

async function readTimeToIndex(db: Db): Promise<KpiValueResult> {
  // Median computed in JS — SQLite has no MEDIAN aggregate. Require at least
  // MIN_TTI_SAMPLES_30D resolved samples in the last 30d before classifying;
  // below that, the median is too noisy and we return INDETERMINATE.
  //
  // Staleness signal: max(first_crawl_at) on time_to_index_log. If the URL
  // Inspection sweep has stopped reconciling rows for >7d, the median is
  // stale and the KPI is STALE rather than reflecting a real lag.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000);
  const [rows, maxRow] = await Promise.all([
    db
      .select({ lagSeconds: timeToIndexLog.lagSeconds })
      .from(timeToIndexLog)
      .where(
        and(
          sql`${timeToIndexLog.lagSeconds} IS NOT NULL`,
          gte(timeToIndexLog.firstCrawlAt, thirtyDaysAgo)
        )
      )
      .orderBy(desc(timeToIndexLog.firstCrawlAt))
      .limit(1000),
    db.select({ ts: sql<number | null>`max(${timeToIndexLog.firstCrawlAt})` }).from(timeToIndexLog),
  ]);
  const maxSec = maxRow[0]?.ts ?? null;
  const dataAgeSeconds = ageSecondsFromDate(maxSec != null ? new Date(maxSec * 1000) : null);
  const lags = rows
    .map((r) => r.lagSeconds)
    .filter((n): n is number => typeof n === "number")
    .sort((a, b) => a - b);
  if (lags.length < MIN_TTI_SAMPLES_30D) {
    return {
      value: null,
      dataAgeSeconds,
      meta: {
        samples: lags.length,
        threshold: MIN_TTI_SAMPLES_30D,
        maxFirstCrawlAt: maxSec,
        reason: "insufficient_samples",
      },
    };
  }
  const medianSec = lags[Math.floor(lags.length / 2)];
  return {
    value: medianSec / 3600,
    dataAgeSeconds,
    meta: { samples: lags.length, median_seconds: medianSec, maxFirstCrawlAt: maxSec },
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
  dataAgeSeconds: number | null,
  prev: { state: KpiState; firstDetectedAt: Date | null } | undefined,
  now: Date
): {
  state: KpiState;
  stateChangedFromPrevious: boolean;
  firstDetectedAt: Date;
  isResolution: boolean;
} {
  const state = classifyKpi(kpi, value, dataAgeSeconds);
  const changed = !prev || prev.state !== state;
  const firstDetectedAt = changed ? now : (prev?.firstDetectedAt ?? now);
  // A "resolution" is a transition out of any unhealthy state (RED, YELLOW,
  // STALE) back to GREEN — that's what the admin_actions audit log captures
  // so the trend isn't lost when the action-queue row drops.
  const isResolution =
    changed &&
    state === "GREEN" &&
    prev != null &&
    (prev.state === "RED" || prev.state === "YELLOW" || prev.state === "STALE");
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
  // A3 (analyst Item 8, 2026-05-30): retain decisions so the post-insert
  // alert dispatch can pull the transition info without recomputing.
  const transitionEvents: Array<{
    kpi: KpiName;
    fromState: KpiState | null;
    toState: KpiState;
    value: number | null;
  }> = [];
  let transitions = 0;
  let resolved = 0;

  for (const kpi of KPI_NAMES) {
    const v = values[kpi];
    const prev = prevByName.get(kpi);
    const decision = decideStateRow(
      kpi,
      v.value,
      v.dataAgeSeconds,
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
      // Persist dataAgeSeconds in meta so the UI can render "Data feed
      // stale 73h" without re-querying the source.
      meta: JSON.stringify({ ...v.meta, dataAgeSeconds: v.dataAgeSeconds }),
    });

    if (decision.stateChangedFromPrevious) {
      transitions += 1;
      transitionEvents.push({
        kpi,
        fromState: prev ? (prev.state as KpiState) : null,
        toState: decision.state,
        value: v.value,
      });
    }
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

  // A3 (analyst Item 8, 2026-05-30): push notifications on threshold
  // transitions. Fire AFTER the row insert so the debounce query inside
  // dispatchKpiAlert can see the just-written row. Dispatch errors are
  // swallowed inside the helper — a failed alert must not roll back the
  // KPI recompute (the data is already canonical in kpi_state_history).
  // GREEN resolutions are NOT alerted (audit row is sufficient); only
  // RED/YELLOW/STALE entries get pushed downstream.
  for (const t of transitionEvents) {
    try {
      await dispatchKpiAlert(db, {
        kpiName: t.kpi,
        fromState: t.fromState,
        toState: t.toState,
        value: t.value,
        detectedAt: now,
      });
    } catch (err) {
      // Belt-and-suspenders: dispatchKpiAlert already swallows internally,
      // but if a future change introduces a throw path we don't want it
      // breaking the recompute return.
       
      console.error(`[kpi-alerts] dispatch failed for ${t.kpi}:`, err);
    }
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
