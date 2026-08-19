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
import {
  eventDiscrepancies,
  goodwillHealthSnapshots,
  adminActions,
  events,
  eventSeries,
  inboundEmails,
  gscDailyTotals,
  gscMilestoneEmails,
} from "../schema.js";
import { deriveCrossings, auditStoredDates } from "@takemetothefair/utils";
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

      // ── OPE-423 invariant: tombstoned AND live ───────────────
      // A row with `merged_into` set must be REJECTED. Anything else means a
      // merged duplicate is back in the public index, competing with its own
      // keeper on the same venue and dates.
      //
      // This is reported as a LIST, not a count. The one real occurrence
      // (`bar-harbor-fall-craft-fair-2026`, resurrected 2026-06-25) survived
      // seven weeks because nothing named it — and a bare "1" in a report is
      // not actionable at 06:00 on a Monday. The ids are what an operator
      // needs to fix it.
      //
      // Capped at 20: if this is ever more than a handful, the count is the
      // story and the list is noise. `violation_count` carries the true total
      // so a truncated list can never read as the whole problem
      // ([[feedback_absence_of_positives_is_not_a_negative]]).
      const tombstoneViolations = await db
        .select({
          id: events.id,
          slug: events.slug,
          name: events.name,
          status: events.status,
          merged_into: events.mergedInto,
        })
        .from(events)
        .where(sql`${events.mergedInto} IS NOT NULL AND ${events.status} <> 'REJECTED'`)
        .limit(20);

      const [tombstoneViolationCount] = await db
        .select({ count: sql<number>`count(*)` })
        .from(events)
        .where(sql`${events.mergedInto} IS NOT NULL AND ${events.status} <> 'REJECTED'`);

      // ── OPE-423 invariant 2: a series canonical pointing at a tombstone ──
      //
      // Found by executing this ticket's own merge. `merge_events` tombstoned
      // the duplicate and inserted the slug-history 301, but never looked at
      // `event_series`. The pair shared a series whose `canonical_slug` was the
      // DUPLICATE's slug, so afterwards the keeper 301'd to the series canonical
      // and the canonical 301'd back to the keeper — a redirect loop that made a
      // 1,214-view APPROVED page unreachable and returned 301 forever.
      //
      // The write path is fixed (merge-operations.ts repoints the canonical in
      // the same batch). This is the check that would have caught it, and the
      // one that catches whatever writes `event_series` next: the defect was
      // never that one function forgot, it was that nothing was watching.
      //
      // Same list-not-count shape as the invariant above, for the same reason.
      const seriesCanonicalViolations = await db
        .select({
          series_id: eventSeries.id,
          canonical_slug: eventSeries.canonicalSlug,
          event_id: events.id,
          event_status: events.status,
          merged_into: events.mergedInto,
        })
        .from(eventSeries)
        .innerJoin(events, eq(events.slug, eventSeries.canonicalSlug))
        .where(sql`${events.mergedInto} IS NOT NULL`)
        .limit(20);

      const [seriesCanonicalViolationCount] = await db
        .select({ count: sql<number>`count(*)` })
        .from(eventSeries)
        .innerJoin(events, eq(events.slug, eventSeries.canonicalSlug))
        .where(sql`${events.mergedInto} IS NOT NULL`);

      // ── OPE-467: claimed vs stored vs skipped, per lane ──────────────
      //
      // This defect ran for three months and was found by hand-diffing
      // `attachment_count` against `attachment_refs`. The acceptance criterion
      // is that nobody has to do that again.
      //
      // Reported per `to_address` because the lane split is what made the
      // original report legible — though note the diagnosis it suggested was
      // wrong: there is ONE capture path, called before intent routing, so a
      // lane difference is a difference in what people SEND, not in code.
      //
      // `unaccounted` is the only number here that is a fault. A skip is a
      // policy decision now that it is recorded; a part that is neither stored
      // nor explained is a part that went missing.
      const attachmentCapture = await db
        .select({
          lane: inboundEmails.toAddress,
          emails: sql<number>`count(*)`,
          claimed: sql<number>`coalesce(sum(${inboundEmails.attachmentCount}), 0)`,
          stored: sql<number>`coalesce(sum((length(coalesce(${inboundEmails.attachmentRefs}, '')) - length(replace(coalesce(${inboundEmails.attachmentRefs}, ''), '"key"', ''))) / 5), 0)`,
          skipped: sql<number>`coalesce(sum((length(coalesce(${inboundEmails.attachmentSkips}, '')) - length(replace(coalesce(${inboundEmails.attachmentSkips}, ''), '"reason"', ''))) / 8), 0)`,
        })
        .from(inboundEmails)
        .where(sql`${inboundEmails.attachmentCount} > 0`)
        .groupBy(inboundEmails.toAddress);

      // ── OPE-472: the three series invariants ─────────────────────────
      //
      // `event_series` was backfilled once and went inert. The newest series
      // row was created 2026-06-30, and 170 of the 172 events created since
      // 2026-07-01 have `series_id` NULL — seven weeks in which every new
      // event was born without a hub and nothing said so.
      //
      // Reported from day one, per the ticket, and NOT enforced as a UNIQUE
      // constraint: `series_duplicate_parent` has 126 live violations (OPE-473),
      // so a constraint could not ship and would hard-fail legitimate writes.
      // An invariant that reports is the thing that can exist today.
      //
      // `series_single_event` is a WATCH, not a failure — a fair with one
      // recorded edition is normal, and only becomes interesting if the number
      // stops falling as editions accumulate.
      const [seriesInvariants] = await db
        .select({
          orphan_live_events: sql<number>`(SELECT count(*) FROM events WHERE series_id IS NULL AND status IN ('APPROVED','TENTATIVE') AND merged_into IS NULL)`,
          orphan_events_since_jul: sql<number>`(SELECT count(*) FROM events WHERE series_id IS NULL AND created_at >= unixepoch('2026-07-01'))`,
          duplicate_parents: sql<number>`(SELECT count(*) FROM (SELECT lower(trim(name)) AS n, venue_id FROM event_series WHERE venue_id IS NOT NULL GROUP BY n, venue_id HAVING count(*) > 1))`,
          single_event_series: sql<number>`(SELECT count(*) FROM (SELECT s.id FROM event_series s JOIN events e ON e.series_id = s.id GROUP BY s.id HAVING count(e.id) = 1))`,
          newest_series_created: sql<string>`(SELECT max(date(created_at, 'unixepoch')) FROM event_series)`,
        })
        .from(sql`(SELECT 1)`);

      // ── OPE-294: hotlinked images, so the trend is answerable ────────
      //
      // The acceptance asks that `health.hotlinked` "trends down and stays
      // down". It has been trending UP: venue hotlinks 172 → 173 and event
      // hotlinks 28 → 51 between the ticket being filed (2026-07-28) and
      // 2026-08-18, the newest arriving that same day. Nothing reported that,
      // which is why it took a re-measurement by hand to notice.
      //
      // Counted here rather than judged: this reports the population, it does
      // not act on it. Whether the existing rows are re-hosted, attributed, or
      // dropped is John's licensing decision, and re-hosting may be MORE
      // restricted than hotlinking.
      const hotlinkedImages = await db
        .select({
          venues_google_places: sql<number>`(SELECT count(*) FROM venues WHERE image_url LIKE '%googleusercontent.com%')`,
          venues_third_party: sql<number>`(SELECT count(*) FROM venues WHERE image_url IS NOT NULL AND image_url <> '' AND image_url NOT LIKE 'https://cdn.meetmeatthefair.com%' AND image_url NOT LIKE '/%')`,
          venues_owned: sql<number>`(SELECT count(*) FROM venues WHERE image_url LIKE 'https://cdn.meetmeatthefair.com%' OR image_url LIKE '/%')`,
          events_third_party: sql<number>`(SELECT count(*) FROM events WHERE image_url IS NOT NULL AND image_url <> '' AND image_url NOT LIKE 'https://cdn.meetmeatthefair.com%' AND image_url NOT LIKE '/%')`,
          events_owned: sql<number>`(SELECT count(*) FROM events WHERE image_url LIKE 'https://cdn.meetmeatthefair.com%' OR image_url LIKE '/%')`,
        })
        .from(sql`(SELECT 1)`);

      // OPE-452 — an email that ARRIVED with content and landed with none.
      //
      // The reported specimen turned out to be captured fine (2,318 chars), but
      // the check it implied is worth having, because an empty body is
      // indistinguishable from a genuinely content-free email — and OPE-407's
      // detector will cheerfully tell a sender "your message was empty" on the
      // strength of exactly this row shape. A false statement about the
      // customer's own words is the worst thing that surface can say.
      //
      // Keyed on raw_size, which is recorded at receive time before any
      // parsing: substantial bytes in, nothing stored, is a capture fault
      // rather than a quiet blank.
      //
      // Excerpt-bearing rows are deliberately EXCLUDED. 177 rows have a NULL
      // body_text/body_html but a populated excerpt — that is the full-body
      // storage gap (OPE-156's territory), not lost content, and folding the
      // two together would report 179 losses where there are 2.
      const emptyCaptureRows = await db
        .select({
          id: inboundEmails.id,
          receivedAt: inboundEmails.receivedAt,
          fromAddress: inboundEmails.fromAddress,
          subject: inboundEmails.subject,
          rawSize: inboundEmails.rawSize,
        })
        .from(inboundEmails)
        .where(
          sql`COALESCE(LENGTH(${inboundEmails.bodyText}), 0) = 0
              AND COALESCE(LENGTH(${inboundEmails.bodyHtml}), 0) = 0
              AND COALESCE(LENGTH(${inboundEmails.bodyTextExcerpt}), 0) = 0
              AND COALESCE(${inboundEmails.rawSize}, 0) > 2000`
        )
        .orderBy(sql`${inboundEmails.receivedAt} DESC`)
        .limit(20);

      const [emptyCaptureCount] = await db
        .select({ count: sql<number>`count(*)` })
        .from(inboundEmails)
        .where(
          sql`COALESCE(LENGTH(${inboundEmails.bodyText}), 0) = 0
              AND COALESCE(LENGTH(${inboundEmails.bodyHtml}), 0) = 0
              AND COALESCE(LENGTH(${inboundEmails.bodyTextExcerpt}), 0) = 0
              AND COALESCE(${inboundEmails.rawSize}, 0) > 2000`
        );

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

      // ── OPE-456 invariant: a stored milestone date we cannot derive ─────
      //
      // The 12,000-click milestone was stored as 2026-08-17 — the date John
      // FORWARDED the mail — when Google's own body said Aug 15. The auto-ingest
      // (OPE-311) stamps `email_date: new Date()` at processing time, and
      // `reached_date` absorbed it. It was corrected by hand after deriving the
      // real crossing from our own `gsc_daily_totals`.
      //
      // OPE-456 shipped that derivation as a tested pure function and **nothing
      // called it**. So the arithmetic that catches this class existed while the
      // class stayed uncaught — which is the OPE-246 defect shape, in a ticket
      // about a silently-wrong date. This is its caller.
      //
      // `differs` is the fault. `underivable` is not: our daily totals only go
      // back so far, and a threshold crossed before the series starts genuinely
      // cannot be derived — reporting that as a violation would train the
      // reader to ignore the check.
      const milestoneRows = await db
        .select({
          threshold: gscMilestoneEmails.threshold,
          reachedDate: gscMilestoneEmails.reachedDate,
        })
        .from(gscMilestoneEmails)
        .where(eq(gscMilestoneEmails.metric, "clicks"));

      const dailyRows = await db
        .select({ date: gscDailyTotals.date, clicks: gscDailyTotals.clicks })
        .from(gscDailyTotals);

      const milestoneAudit = auditStoredDates(
        milestoneRows.map((r) => ({ threshold: r.threshold, reachedDate: r.reachedDate })),
        deriveCrossings(
          dailyRows.map((d) => ({ date: d.date, clicks: d.clicks })),
          milestoneRows.map((r) => r.threshold),
          28
        )
      );
      const milestoneDrift = milestoneAudit.filter((a) => a.verdict === "differs");

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
            // OPE-423. `violations` is capped at 20; `violation_count` is the
            // real total, so a truncated list never reads as the whole set.
            merged_tombstone_invariant: {
              rule: "events.merged_into IS NOT NULL implies status = 'REJECTED'",
              violation_count: Number(tombstoneViolationCount?.count ?? 0),
              violations: tombstoneViolations,
            },
            // OPE-467 — claimed vs stored vs skipped per lane. `unaccounted`
            // is the fault number; a recorded skip is a policy decision.
            //
            // ⚠️ Rows received before 2026-07-03 will always show unaccounted:
            // `captureAttachments` did not exist until commit 9de7b361
            // (OPE-68), so those attachments were never filtered — there was
            // nothing to filter them. Not backfillable; the raw MIME is gone.
            attachment_capture: attachmentCapture.map((r) => ({
              ...r,
              unaccounted: Number(r.claimed) - Number(r.stored) - Number(r.skipped),
            })),
            // OPE-472 — series parentage. `orphan_events_since_jul` is the
            // one that says whether the write-path fix is actually holding:
            // it should stop growing the day it ships, while the live-orphan
            // backlog is a separate (backfill) question.
            series_invariants: seriesInvariants ?? null,
            // OPE-294 — the hotlink population, so "trends down" is checkable
            // rather than asserted. `venues_google_places` is the subset with a
            // licensing question attached.
            hotlinked_images: hotlinkedImages[0] ?? null,
            // OPE-423 invariant 2 — see the comment at the query.
            series_canonical_invariant: {
              rule: "event_series.canonical_slug must not name an event with merged_into set",
              violation_count: Number(seriesCanonicalViolationCount?.count ?? 0),
              violations: seriesCanonicalViolations,
            },
            // OPE-452. Same capped-list-plus-true-total shape as the
            // tombstone check above, so a truncated list never reads as the
            // whole set.
            inbound_body_capture: {
              rule: "raw_size > 2KB implies SOME body captured (text, html, or excerpt)",
              violation_count: Number(emptyCaptureCount?.count ?? 0),
              violations: emptyCaptureRows.map((r) => ({
                id: r.id,
                received_at: r.receivedAt,
                from: r.fromAddress,
                subject: r.subject,
                raw_size: r.rawSize,
              })),
            },
            // OPE-456 — stored milestone dates checked against our OWN daily
            // totals. `drift` is the fault; `underivable` counts are reported
            // separately so a short history never reads as a defect.
            gsc_milestone_date_drift: {
              rule: "gsc_milestone_emails.reached_date must match the derived 28-day crossing from gsc_daily_totals",
              violation_count: milestoneDrift.length,
              violations: milestoneDrift,
              underivable_count: milestoneAudit.filter((a) => a.verdict === "underivable").length,
              audited: milestoneAudit.length,
            },
            snapshot_trend: trend,
          }),
        ],
      };
    }
  );
}
