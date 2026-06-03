/**
 * GW1e `get_data_health_report` admin MCP tool — the CPI report-card
 * surfaced via MCP rather than a React page.
 *
 * Returns the same data the dev-email's hypothetical
 * /admin/data-health page would render:
 *   - Outreach queue snapshot (top 20 by priority)
 *   - Reliability matrix summary (per-source-type axis medians)
 *   - Phase-1-available CPI metrics
 *   - Phase-2-pending metric stubs (never silently zero per B8)
 *   - Snapshot trend (last 14 days)
 *
 * Cross-links to get_source_quality + get_source_reliability via
 * `source_key` so admins can hop dashboards.
 *
 * Admin only.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { desc, eq, gte, sql } from "drizzle-orm";
import { eventDiscrepancies, goodwillHealthSnapshots, adminActions } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

const TWENTY_EIGHT_DAYS_SECS = 28 * 24 * 60 * 60;

export function registerDataHealthTool(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "get_data_health_report",
    "Goodwill Engine CPI report-card. Returns outreach queue snapshot (top 20 by priority), reliability matrix summary, 28-day resolution metrics, and a 14-day snapshot trend. Phase-2-only metrics (calibration-vs-promoter-confirmed-truth, false-flag rate) are stubbed as 'Awaiting Phase 2 promoter-reply data' rather than silently zero (per B8 of the dev-email spec). Cross-links to get_source_quality + get_source_reliability. Admin only.",
    {
      queue_top_n: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe("Number of top-priority queue entries to include (default 20, max 100)."),
      trend_days: z
        .number()
        .int()
        .min(1)
        .max(60)
        .optional()
        .default(14)
        .describe("Days of snapshot history to include in the trend (default 14, max 60)."),
    },
    async (params) => {
      const queueTopN = params.queue_top_n ?? 20;
      const trendDays = params.trend_days ?? 14;
      const since28dSecs = Math.floor(Date.now() / 1000) - TWENTY_EIGHT_DAYS_SECS;

      // ── Outreach queue snapshot (top N) ──────────────────────
      const queue = await db
        .select({
          id: eventDiscrepancies.id,
          event_id: eventDiscrepancies.eventId,
          field_class: eventDiscrepancies.fieldClass,
          divergent_source_key: eventDiscrepancies.divergentSourceKey,
          outreach_priority_score: eventDiscrepancies.outreachPriorityScore,
          outreach_candidate: eventDiscrepancies.outreachCandidate,
          detected_at: eventDiscrepancies.detectedAt,
          notes: eventDiscrepancies.notes,
        })
        .from(eventDiscrepancies)
        .where(eq(eventDiscrepancies.resolutionStatus, "open"))
        .orderBy(
          desc(eventDiscrepancies.outreachPriorityScore),
          desc(eventDiscrepancies.detectedAt)
        )
        .limit(queueTopN);

      // ── Phase-1 CPI metrics ──────────────────────────────────
      const overrideRateRows = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(adminActions)
        .where(
          sql`${adminActions.action} LIKE 'discrepancy.%' AND ${adminActions.createdAt} > ${since28dSecs}`
        );
      const operatorOverrides28d = Number(overrideRateRows[0]?.count ?? 0);

      const resolutionRows = await db
        .select({
          status: eventDiscrepancies.resolutionStatus,
          count: sql<number>`COUNT(*)`,
        })
        .from(eventDiscrepancies)
        .where(gte(eventDiscrepancies.resolvedAt, new Date(since28dSecs * 1000)))
        .groupBy(eventDiscrepancies.resolutionStatus);

      let resolved28d = 0;
      let dismissed28d = 0;
      let resolvedAuth28d = 0;
      let resolvedDiv28d = 0;
      for (const r of resolutionRows) {
        const c = Number(r.count);
        if (r.status === "dismissed") dismissed28d += c;
        else if (r.status !== "open") {
          resolved28d += c;
          if (r.status === "resolved_authoritative") resolvedAuth28d += c;
          if (r.status === "resolved_divergent") resolvedDiv28d += c;
        }
      }

      const groundTruthCoverage =
        resolved28d + dismissed28d === 0 ? null : resolved28d / (resolved28d + dismissed28d);

      // ── Snapshot trend ───────────────────────────────────────
      const trend = await db
        .select({
          snapshot_date: goodwillHealthSnapshots.snapshotDate,
          open_count: goodwillHealthSnapshots.openCount,
          outreach_candidates: goodwillHealthSnapshots.outreachCandidateCount,
          weighted_priority_sum: goodwillHealthSnapshots.weightedPrioritySum,
          median_official_freshness: goodwillHealthSnapshots.medianOfficialFreshness,
          median_official_accuracy: goodwillHealthSnapshots.medianOfficialAccuracy,
          median_aggregator_accuracy: goodwillHealthSnapshots.medianAggregatorAccuracy,
        })
        .from(goodwillHealthSnapshots)
        .orderBy(desc(goodwillHealthSnapshots.snapshotDate))
        .limit(trendDays);

      // ── Build the response ───────────────────────────────────
      const today = trend[0];
      const phase1Metrics = {
        operator_override_actions_last_28d: operatorOverrides28d,
        resolved_last_28d: resolved28d,
        resolved_authoritative_last_28d: resolvedAuth28d,
        resolved_divergent_last_28d: resolvedDiv28d,
        dismissed_last_28d: dismissed28d,
        ground_truth_coverage:
          groundTruthCoverage === null ? null : Number(groundTruthCoverage.toFixed(3)),
      };

      const phase2PendingMetrics = {
        // B8: never silently zero. Always show "awaiting" until Phase 2
        // ships the outreach communication layer.
        calibration_vs_promoter_confirmed_truth: "Awaiting Phase 2 promoter-reply data",
        false_flag_rate: "Awaiting Phase 2 promoter-reply data",
        promoter_reply_response_rate: "Awaiting Phase 2 promoter-reply data",
      };

      return {
        content: [
          jsonContent({
            generated_at: new Date().toISOString(),
            today_snapshot: today ?? null,
            outreach_queue_top: queue.map((q) => ({
              ...q,
              cross_links: q.divergent_source_key
                ? {
                    source_quality: `get_source_quality { source_domain: '${q.divergent_source_key}' }`,
                    source_reliability: `get_source_reliability { source_key: '${q.divergent_source_key}' }`,
                  }
                : null,
            })),
            phase1_metrics: phase1Metrics,
            phase2_pending_metrics: phase2PendingMetrics,
            snapshot_trend: trend,
          }),
        ],
      };
    }
  );
}
