/**
 * GW1e — daily goodwill-engine health canary.
 *
 * Once per day on the existing `0 6 * * *` cron, snapshots the open
 * outreach queue + weighted-priority sum + per-detector breakdown +
 * per-tier reliability medians into `goodwill_health_snapshots`, then
 * dispatches a Slack alert when the queue grows materially.
 *
 * Mirrors the dedup-sweep canary at `mcp-server/src/dedup-sweep-
 * canary.ts` so operators experience the alerts consistently:
 *
 *   RED   on +N open-queue growth day-over-day. Always fires (no
 *         debounce). N defaults to 1 — any new accumulation is worth
 *         a look in the Phase 1 baseline.
 *   YELLOW on >10% growth over the prior 7-day rolling average of the
 *         weighted-priority sum. Debounced 72h via
 *         last_yellow_alerted_at.
 *
 * Routes to SLACK_WEBHOOK_URL_TECHNICAL — same channel as KPI alerts
 * and the dedup canary. When the secret is unset the helper logs but
 * doesn't fail (local dev / CI without secrets keeps working).
 *
 * ## Why a separate canary
 *
 * The dedup sweep monitors a cluster-count signal; this one monitors
 * an action-queue signal. They share the same data-quality theme but
 * the alerting thresholds differ — dedup growth is rare and should
 * always be RED; goodwill discrepancies accumulate naturally and the
 * RED threshold is configurable.
 */

import { sql, eq, gte } from "drizzle-orm";
import { eventDiscrepancies, sourceReliability, goodwillHealthSnapshots } from "../schema.js";
import type { Db } from "../db.js";
import { logError } from "../logger.js";

export interface CanaryOpts {
  /** Slack incoming-webhook URL. When omitted, the canary still
   *  writes the snapshot + computes the decision, but no Slack POST
   *  fires — local dev / CI without secrets keeps working. */
  slackWebhookUrl?: string | null;
}

const RED_GROWTH_THRESHOLD = 1; // +N open rows day-over-day
const YELLOW_GROWTH_RATIO = 0.1; // >10% over 7-day rolling avg
const YELLOW_DEBOUNCE_SECS = 72 * 60 * 60;
const TWENTY_EIGHT_DAYS_SECS = 28 * 24 * 60 * 60;

export interface CanaryResult {
  decision: "noop" | "wrote_snapshot" | "wrote_snapshot_and_red" | "wrote_snapshot_and_yellow";
  snapshot_date: string;
  open_count: number;
  weighted_priority_sum: number;
  prior_open_count: number | null;
  prior_7d_avg_weighted: number | null;
}

/** UTC YYYY-MM-DD for the snapshot key. */
function snapshotDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Compute median over an array of nullable numbers. Drops nulls.
 * Returns null if no values remain (so the snapshot column can stay
 * null in the "no data yet" case, rather than emitting a misleading 0).
 */
function median(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  nums.sort((a, b) => a - b);
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}

async function fetchOpenCounts(db: Db): Promise<{
  total: number;
  outreachCandidates: number;
  weightedSum: number;
  byDetector: Record<string, number>;
}> {
  const totalRow = await db
    .select({
      total: sql<number>`COUNT(*)`,
      outreachCandidates: sql<number>`SUM(CASE WHEN outreach_candidate = 1 THEN 1 ELSE 0 END)`,
      weightedSum: sql<number>`COALESCE(SUM(outreach_priority_score), 0)`,
    })
    .from(eventDiscrepancies)
    .where(eq(eventDiscrepancies.resolutionStatus, "open"));

  const byDetectorRows = await db
    .select({
      detectedBy: eventDiscrepancies.detectedBy,
      count: sql<number>`COUNT(*)`,
    })
    .from(eventDiscrepancies)
    .where(eq(eventDiscrepancies.resolutionStatus, "open"))
    .groupBy(eventDiscrepancies.detectedBy);

  const byDetector: Record<string, number> = {};
  for (const row of byDetectorRows) {
    byDetector[row.detectedBy] = Number(row.count);
  }

  return {
    total: Number(totalRow[0]?.total ?? 0),
    outreachCandidates: Number(totalRow[0]?.outreachCandidates ?? 0),
    weightedSum: Number(totalRow[0]?.weightedSum ?? 0),
    byDetector,
  };
}

async function fetchResolutionCounts(
  db: Db
): Promise<{ resolved28d: number; dismissed28d: number }> {
  const cutoff = new Date(Date.now() - TWENTY_EIGHT_DAYS_SECS * 1000);
  const rows = await db
    .select({
      resolutionStatus: eventDiscrepancies.resolutionStatus,
      count: sql<number>`COUNT(*)`,
    })
    .from(eventDiscrepancies)
    .where(gte(eventDiscrepancies.resolvedAt, cutoff))
    .groupBy(eventDiscrepancies.resolutionStatus);

  let resolved28d = 0;
  let dismissed28d = 0;
  for (const row of rows) {
    const c = Number(row.count);
    if (row.resolutionStatus === "dismissed") dismissed28d += c;
    else if (row.resolutionStatus !== "open") resolved28d += c;
  }
  return { resolved28d, dismissed28d };
}

async function fetchReliabilityMedians(db: Db): Promise<{
  medianOfficialFreshness: number | null;
  medianOfficialAccuracy: number | null;
  medianAggregatorAccuracy: number | null;
}> {
  const rows = await db
    .select({
      priorType: sourceReliability.priorType,
      axis: sourceReliability.axis,
      score: sourceReliability.score,
    })
    .from(sourceReliability);

  const officialFreshness = rows
    .filter((r) => r.priorType === "official" && r.axis === "freshness")
    .map((r) => r.score);
  const officialAccuracy = rows
    .filter((r) => r.priorType === "official" && r.axis === "accuracy")
    .map((r) => r.score);
  const aggregatorAccuracy = rows
    .filter((r) => r.priorType === "aggregator" && r.axis === "accuracy")
    .map((r) => r.score);

  return {
    medianOfficialFreshness: median(officialFreshness),
    medianOfficialAccuracy: median(officialAccuracy),
    medianAggregatorAccuracy: median(aggregatorAccuracy),
  };
}

async function lookupPriorSnapshots(
  db: Db,
  today: string
): Promise<{ priorOpen: number | null; sevenDayAvgWeighted: number | null }> {
  const recent = await db
    .select()
    .from(goodwillHealthSnapshots)
    .orderBy(sql`${goodwillHealthSnapshots.snapshotDate} desc`)
    .limit(7);

  const beforeToday = recent.filter((r) => r.snapshotDate !== today);
  const priorOpen = beforeToday[0]?.openCount ?? null;
  const avgWeighted =
    beforeToday.length === 0
      ? null
      : beforeToday.reduce((sum, r) => sum + r.weightedPrioritySum, 0) / beforeToday.length;
  return { priorOpen, sevenDayAvgWeighted: avgWeighted };
}

async function postSlack(db: Db, slackUrl: string | null | undefined, text: string): Promise<void> {
  if (!slackUrl) {
    console.log("[goodwill-canary] slackWebhookUrl unset — skipping dispatch");
    return;
  }
  try {
    await fetch(slackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    await logError(db, {
      source: "mcp:goodwill:health-canary:slack",
      message: "Slack webhook POST failed",
      error: err,
    });
  }
}

/**
 * Per [[feedback_drizzle_d1_unit_test_inject_db]] — accept `db: Db`
 * directly. The cron caller in `mcp-server/src/index.ts` wraps env.DB
 * via `getDb(env.DB)` and passes env.SLACK_WEBHOOK_URL_TECHNICAL as
 * `slackWebhookUrl` so the helper can run identically in tests with
 * an in-memory better-sqlite3 Db.
 */
export async function runScheduledGoodwillHealthCanary(
  db: Db,
  opts: CanaryOpts = {}
): Promise<CanaryResult> {
  const SOURCE = "mcp:schedule:goodwill-health-canary";
  const today = snapshotDate();

  try {
    const open = await fetchOpenCounts(db);
    const resolutions = await fetchResolutionCounts(db);
    const reliability = await fetchReliabilityMedians(db);
    const prior = await lookupPriorSnapshots(db, today);

    // Upsert today's snapshot (idempotent on re-run same day).
    const existing = await db
      .select()
      .from(goodwillHealthSnapshots)
      .where(eq(goodwillHealthSnapshots.snapshotDate, today))
      .limit(1);

    const payload = {
      snapshotDate: today,
      openCount: open.total,
      outreachCandidateCount: open.outreachCandidates,
      weightedPrioritySum: open.weightedSum,
      openIngestAddverify: open.byDetector["ingest_addverify"] ?? 0,
      openStalePageRadar: open.byDetector["stale_page_radar"] ?? 0,
      openSelfConsistency: open.byDetector["self_consistency"] ?? 0,
      openManual: open.byDetector["manual"] ?? 0,
      resolvedLast28d: resolutions.resolved28d,
      dismissedLast28d: resolutions.dismissed28d,
      ...reliability,
    };

    const lastYellowAt: Date | null = existing[0]?.lastYellowAlertedAt ?? null;

    if (existing.length === 0) {
      await db.insert(goodwillHealthSnapshots).values({
        ...payload,
        lastYellowAlertedAt: null,
        createdAt: new Date(),
      });
    } else {
      await db
        .update(goodwillHealthSnapshots)
        .set(payload)
        .where(eq(goodwillHealthSnapshots.id, existing[0].id));
    }

    // RED check — +N open day-over-day, always fires.
    let decision: CanaryResult["decision"] = "wrote_snapshot";
    if (prior.priorOpen !== null && open.total >= prior.priorOpen + RED_GROWTH_THRESHOLD) {
      await postSlack(
        db,
        opts.slackWebhookUrl,
        `:rotating_light: *Goodwill queue RED* — open count ${prior.priorOpen} → ${open.total} (+${
          open.total - prior.priorOpen
        }). Outreach candidates: ${open.outreachCandidates}.`
      );
      decision = "wrote_snapshot_and_red";
    } else if (
      prior.sevenDayAvgWeighted !== null &&
      prior.sevenDayAvgWeighted > 0 &&
      open.weightedSum > prior.sevenDayAvgWeighted * (1 + YELLOW_GROWTH_RATIO)
    ) {
      // YELLOW debounce check.
      const ageSecs = lastYellowAt ? (Date.now() - lastYellowAt.getTime()) / 1000 : Infinity;
      if (ageSecs >= YELLOW_DEBOUNCE_SECS) {
        const pct = (
          (100 * (open.weightedSum - prior.sevenDayAvgWeighted)) /
          prior.sevenDayAvgWeighted
        ).toFixed(1);
        await postSlack(
          db,
          opts.slackWebhookUrl,
          `:warning: *Goodwill queue YELLOW* — weighted priority sum ${prior.sevenDayAvgWeighted.toFixed(
            1
          )} (7d avg) → ${open.weightedSum.toFixed(1)} (+${pct}%).`
        );
        // Bump the debounce marker.
        await db
          .update(goodwillHealthSnapshots)
          .set({ lastYellowAlertedAt: new Date() })
          .where(eq(goodwillHealthSnapshots.snapshotDate, today));
        decision = "wrote_snapshot_and_yellow";
      }
    }

    console.log(
      `[cron] goodwill-health-canary ${decision} — open=${open.total} weighted=${open.weightedSum.toFixed(
        2
      )} prior_open=${prior.priorOpen ?? "null"}`
    );

    return {
      decision,
      snapshot_date: today,
      open_count: open.total,
      weighted_priority_sum: open.weightedSum,
      prior_open_count: prior.priorOpen,
      prior_7d_avg_weighted: prior.sevenDayAvgWeighted,
    };
  } catch (error) {
    await logError(db, {
      source: SOURCE,
      message: "goodwill health canary threw unhandled exception",
      error,
    });
    return {
      decision: "noop",
      snapshot_date: today,
      open_count: 0,
      weighted_priority_sum: 0,
      prior_open_count: null,
      prior_7d_avg_weighted: null,
    };
  }
}
