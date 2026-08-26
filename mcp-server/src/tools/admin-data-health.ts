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
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
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
import { loadLocationsUniverse } from "../locations-universe.js";
import { listBalance } from "../newsletter-list-balance.js";
import type { Db } from "../db.js";
import { findSlugCollisionPairs } from "../slug-collision-invariant.js";
import type { AuthContext } from "../auth.js";

const TWENTY_EIGHT_DAYS_SECS = 28 * 24 * 60 * 60;
/** OPE-526 — window for the vendor-application capture probe. 90d is wide
 *  enough that a low-volume lane still shows a meaningful denominator; a 28d
 *  window put `direct_scrape` in single digits, where 0/3 says nothing. */
const VENDOR_CAPTURE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Epoch SECONDS at which the OPE-472 series write-path fix (PR #931) deployed:
 * 2026-08-19T14:00:00Z.
 *
 * A fixed constant, not a rolling window. The question it answers — "has the
 * writer parented every event it should since it started running" — has a
 * fixed start, and a rolling window would quietly forgive a regression as soon
 * as it aged out.
 *
 * SECONDS because D1 stores these columns as seconds; a millisecond value here
 * is far in the future, matches nothing, and reports a clean zero that reads
 * exactly like success.
 */
const SERIES_WRITE_PATH_SHIPPED_AT = 1787148000;

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

      // ── OPE-404 — an inbound email stuck on `failed` has no owner ────
      //
      // The LIKE-pattern defect that killed `401adb3c` ("Belgrade Lakes",
      // photo_intake) was FIXED on 2026-08-16 by PR #863. The row was still
      // `status='failed'`, `resulting_event_id` NULL, photo never delivered,
      // when this was written on 2026-08-20 — ten days after arrival and four
      // days after the cause stopped existing.
      //
      // That gap is the real defect. Fixing the cause does not move rows that
      // already failed, and nothing counts them, so a dead submission waits for
      // somebody to go looking. `failed` is terminal in the workflow — there is
      // no retry that reaches it.
      //
      // Counted with an AGE, not just a total: a row that failed ten minutes
      // ago may still be mid-retry, and a count alone cannot tell that from one
      // abandoned for a fortnight. `oldest_failed_days` is the number that says
      // somebody has to act.
      //
      // Reports, does not replay: replaying a photo email writes to a public
      // gallery, and which event a photo belongs to is often exactly the
      // question that failed. Belgrade Lakes is genuinely ambiguous — two
      // approved events share the name.
      const [stuckInbound] = await db
        .select({
          failed_total: sql<number>`(SELECT count(*) FROM inbound_emails WHERE status = 'failed')`,
          failed_photo_intake: sql<number>`(SELECT count(*) FROM inbound_emails WHERE status = 'failed' AND intent = 'photo_intake')`,
          failed_unresolved: sql<number>`(SELECT count(*) FROM inbound_emails WHERE status = 'failed' AND resulting_event_id IS NULL)`,
          // OPE-551 — EXCLUDED, NOT DISCARDED. Rows that failed and were later
          // resolved. Should normally be 0; a non-zero value means a recovery
          // path attached a photo without clearing the status and the daily
          // exception rail has not caught up yet. Reported so that gap is
          // visible in the same response that now excludes it, rather than
          // being silently absorbed into an age nobody can explain.
          failed_but_resolved: sql<number>`(SELECT count(*) FROM inbound_emails WHERE status = 'failed' AND resulting_event_id IS NOT NULL)`,
          // OPE-551 — the age must key on UNRESOLVED rows, like the count above.
          //
          // This counted every `status='failed'` row, so a resolved email whose
          // photo had just been delivered still set the age. That is the number
          // PR #966 described as "the number that says somebody has to act",
          // and it was saying it about work already done.
          //
          // Fixing the writer (`resolveHeldPhotoEmail` now clears the status)
          // closes today's instance. This is the durable half: a health metric
          // must not depend on every future writer remembering to tidy up, nor
          // on a daily reconcile having run since the last recovery.
          //
          // unixepoch() and received_at are both SECONDS — 86400, not 86400000.
          oldest_failed_days: sql<
            number | null
          >`(SELECT CAST((unixepoch() - MIN(received_at)) / 86400 AS INTEGER) FROM inbound_emails WHERE status = 'failed' AND resulting_event_id IS NULL)`,
        })
        .from(sql`(SELECT 1)`);

      // ── OPE-292 — a placeholder must never sit in the registration partition ──
      //
      // `users.origin` exists so a real-user count does not have to match an
      // email string. That only works while every creation path stamps it, and
      // one did not: `createOrLinkVendor` in packages/vendor-linking minted
      // **389** placeholder rows as `registration` between 2026-08-18 and
      // 2026-08-20, taking that partition to 64% noise.
      //
      // The writer is fixed and the rows relabelled (drizzle/0223), but a
      // column whose correctness depends on every future writer remembering is
      // a column that will be wrong again. This is the check that says so.
      //
      // Target is 0. Non-zero means a creation path is not stamping origin —
      // grep the WORKSPACE for `insert(users)`, not just the app: that is
      // precisely how the first fix reached three of four writers.
      const [placeholderOrigin] = await db
        .select({
          misfiled_placeholders: sql<number>`(SELECT count(*) FROM users WHERE origin = 'registration' AND email LIKE 'pending+%')`,
          registration_total: sql<number>`(SELECT count(*) FROM users WHERE origin = 'registration')`,
          ingestion_total: sql<number>`(SELECT count(*) FROM users WHERE origin = 'ingestion')`,
        })
        .from(sql`(SELECT 1)`);

      // OPE-278 item 3 — live `-N` slug pairs; see slug-collision-invariant.ts
      // for why this is narrow (42 suffixed events in prod, 2 real defects).
      const slugCollisions = await findSlugCollisionPairs(db);

      // ── OPE-505: split date anchors ───────────────────────────────────
      //
      // `create_event_citation` parsed a bare `YYYY-MM-DD` with `new Date()`,
      // landing it at 00:00:00Z instead of the canonical noon anchor, and wrote
      // it straight into the events column. On a row whose end_date was already
      // correct that leaves start at midnight and end at noon — a shape nothing
      // else produces, which is why it works as a signature.
      //
      // Midnight UTC renders as the PREVIOUS calendar day everywhere in the US,
      // so each of these is a fair advertised a day early. Five rows in prod at
      // the time of the fix, every one of them carrying exactly one start_date
      // citation. Counted here so the number cannot climb again unnoticed.
      //
      // Raw SQL: D1 date columns are SECONDS. A `% 86400` gives seconds into
      // the UTC day — 0 is midnight, 43200 is noon.
      const splitAnchorRows = await db.all<{
        slug: string;
        status: string;
        start_date: number;
        end_date: number;
      }>(sql`
        SELECT slug, status, start_date, end_date
        FROM events
        WHERE merged_into IS NULL
          AND start_date IS NOT NULL AND end_date IS NOT NULL
          AND (
            (start_date % 86400 = 0     AND end_date % 86400 = 43200)
            OR (start_date % 86400 = 43200 AND end_date % 86400 = 0)
          )
        ORDER BY start_date
        LIMIT 50
      `);

      // ── OPE-482: midnight-UTC date anchors ────────────────────────────
      //
      // The generalization of `split_date_anchor` above. That one catches a
      // narrow signature (one column at midnight, its sibling at noon); this
      // one catches the convention itself, on every date column that reaches a
      // rendered surface.
      //
      // Load-bearing since 2026-08-25: date-only formatters now render in
      // America/New_York, not UTC. Under UTC a midnight-UTC value displayed the
      // intended day and the defect was invisible; under Eastern it displays the
      // PREVIOUS day. So this count is no longer a tidiness metric — every row
      // it returns is a wrong date on a live page.
      //
      // `public_start_date` is here because it is what the event card actually
      // renders (`event.publicStartDate ?? event.startDate`), and it was the
      // largest population by two orders of magnitude when this shipped: 695
      // rows, against 30 on `start_date`. `application_deadline` is here because
      // a day-early deadline tells a vendor they missed a window they had not.
      //
      // Expected 0 after drizzle/0232. Non-zero means a write path bypassed
      // normalizeEventDate again — which is exactly how this recurred: OPE-307
      // fixed ingest, drizzle/0199 backfilled start_date, and three rows still
      // arrived on 2026-08-13/17 through `create_occurrence`'s own hand-rolled
      // `new Date(s)`.
      //
      // Raw SQL: D1 date columns are SECONDS, so `% 86400 = 0` is midnight UTC.
      const [midnightAnchors] = await db.all<{
        start_date: number;
        end_date: number;
        public_start_date: number;
        public_end_date: number;
        application_deadline: number;
      }>(sql`
        SELECT
          COALESCE(SUM(start_date % 86400 = 0), 0)           AS start_date,
          COALESCE(SUM(end_date % 86400 = 0), 0)             AS end_date,
          COALESCE(SUM(public_start_date % 86400 = 0), 0)    AS public_start_date,
          COALESCE(SUM(public_end_date % 86400 = 0), 0)      AS public_end_date,
          COALESCE(SUM(application_deadline % 86400 = 0), 0) AS application_deadline
        FROM events
        WHERE merged_into IS NULL
      `);
      const midnightAnchorTotal =
        Number(midnightAnchors?.start_date ?? 0) +
        Number(midnightAnchors?.end_date ?? 0) +
        Number(midnightAnchors?.public_start_date ?? 0) +
        Number(midnightAnchors?.public_end_date ?? 0) +
        Number(midnightAnchors?.application_deadline ?? 0);

      // ── OPE-543: public_* must be DERIVED, never a copy ───────────────
      //
      // `public_start_date`/`public_end_date` are what the site serves to
      // everyone who is not an admin or a vendor. They mean "the first and last
      // day the public can attend" — the event_days span minus vendor_only setup
      // days — so they legitimately differ from start_date ONLY when such days
      // exist.
      //
      // Two violations, deliberately counted apart because they have different
      // causes and different fixes:
      //
      //   orphaned_copies  public_* set on a row with NO event_days. There is
      //                    nothing to derive it from, so it is a copy of
      //                    start/end that no write path invalidates. 326 rows on
      //                    2026-08-25; only 37 had gone stale, the rest were the
      //                    same defect awaiting their first date edit.
      //   stale_derivation public_* disagrees with the days it should come from.
      //
      // This one is worth more than the usual invariant because the defect is
      // invisible from the inside: admins and vendors are served `start_date`
      // (events/[slug]/page.tsx:1156-1167), so the people who could notice see
      // the correct date and only the public sees the wrong one. It also escapes
      // the daily sweep, which filters and orders on `start_date` — the detector
      // and the defect were keyed to different columns.
      //
      // Expected 0/0 after drizzle/0234.
      const [publicDateDerivation] = await db.all<{
        orphaned_copies: number;
        stale_derivation: number;
      }>(sql`
        SELECT
          (SELECT COUNT(*) FROM events e
             WHERE e.merged_into IS NULL
               AND e.public_start_date IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM event_days d WHERE d.event_id = e.id)
          ) AS orphaned_copies,
          (SELECT COUNT(*) FROM events e
             WHERE e.merged_into IS NULL
               AND EXISTS (SELECT 1 FROM event_days d WHERE d.event_id = e.id)
               AND IFNULL(date(e.public_start_date,'unixepoch'),'~') <>
                   IFNULL((SELECT MIN(d.date) FROM event_days d
                             WHERE d.event_id = e.id AND d.vendor_only = 0),'~')
          ) AS stale_derivation
      `);

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
          // OPE-472 rework — split the orphan count by CAUSE.
          //
          // The single total above cost a false REVIEW FAIL on 2026-08-20: the
          // number kept climbing (170 → 172), which was read as "the write path
          // never resumed". Measured directly, the write path was working —
          // of 6 events created after it deployed, the 4 with a venue were all
          // parented. The 2 that were not had `venue_id IS NULL`, which the
          // resolver skips deliberately, because keying on name alone would put
          // every "Holiday Craft Fair" in New England under one parent.
          //
          // So the two halves have to be counted apart or the invariant cannot
          // express its own success:
          //   *_with_venue — a real defect. Should be 0. Non-zero means the
          //                  write path genuinely is not firing.
          //   *_no_venue   — blocked upstream on venue resolution, not a
          //                  parentage bug. Drains via the late attach in
          //                  update_event as venues get assigned.
          orphan_since_jul_with_venue: sql<number>`(SELECT count(*) FROM events WHERE series_id IS NULL AND venue_id IS NOT NULL AND created_at >= unixepoch('2026-07-01'))`,
          orphan_since_jul_no_venue: sql<number>`(SELECT count(*) FROM events WHERE series_id IS NULL AND venue_id IS NULL AND created_at >= unixepoch('2026-07-01'))`,
          orphan_live_with_venue: sql<number>`(SELECT count(*) FROM events WHERE series_id IS NULL AND venue_id IS NOT NULL AND status IN ('APPROVED','TENTATIVE') AND merged_into IS NULL)`,
          orphan_live_no_venue: sql<number>`(SELECT count(*) FROM events WHERE series_id IS NULL AND venue_id IS NULL AND status IN ('APPROVED','TENTATIVE') AND merged_into IS NULL)`,
          // Liveness, stated positively. A non-decreasing orphan total is NOT
          // evidence of a dead writer — that inference is what went wrong — so
          // report the thing that actually moves when the writer runs.
          assigned_since_jul: sql<number>`(SELECT count(*) FROM events WHERE series_id IS NOT NULL AND created_at >= unixepoch('2026-07-01'))`,
          // ⚠️ THE number to read. Everything above is anchored at 2026-07-01,
          // which predates the write-path fix by seven weeks, so those counts
          // are dominated by the PRE-FIX backlog and cannot go to zero no
          // matter how well the writer behaves: `orphan_since_jul_with_venue`
          // reads 146, and all 146 were created before the fix existed. That
          // backlog is OPE-473's gated backfill, not a live defect.
          //
          // Anchoring on the deploy instant separates "did the fix work" from
          // "is the backlog cleared". Verified in prod 2026-08-20:
          //   orphan_after_fix_with_venue = 0   ← the writer is correct
          //   orphan_after_fix_no_venue   = 2   ← skipped by design, drains
          //                                        via the late attach
          //
          // Shipping this without the anchor would have handed the next
          // reviewer a 146 to misread — which is precisely the mistake that
          // failed this ticket's first review, reproduced one level up.
          orphan_after_fix_with_venue: sql<number>`(SELECT count(*) FROM events WHERE series_id IS NULL AND venue_id IS NOT NULL AND created_at >= ${SERIES_WRITE_PATH_SHIPPED_AT})`,
          orphan_after_fix_no_venue: sql<number>`(SELECT count(*) FROM events WHERE series_id IS NULL AND venue_id IS NULL AND created_at >= ${SERIES_WRITE_PATH_SHIPPED_AT})`,
          series_created_last_7d: sql<number>`(SELECT count(*) FROM event_series WHERE created_at >= unixepoch('now','-7 days'))`,
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

      // OPE-425 review finding 7 — the locations table shipped with zero oracle
      // coverage, so every claim about the project's newest table was a local
      // measurement with no read path. This is also finding 6's answer: the
      // rows-in/rows-stored assertion runs HERE, continuously, against real
      // rows — stronger than the one-off local check that caught the original
      // 423-row silent loss. Fail-soft: a health report that cannot render
      // because one block threw is worse than a block that says it failed.
      // OPE-510 — cheap enough to run unconditionally; three COUNTs.
      let newsletterListBalance: unknown;
      try {
        newsletterListBalance = await listBalance(db);
      } catch (err) {
        newsletterListBalance = {
          error: "newsletter_list_balance_failed",
          detail: err instanceof Error ? err.message : String(err),
        };
      }

      let locationsUniverse: unknown;
      try {
        locationsUniverse = await loadLocationsUniverse(db);
      } catch (err) {
        locationsUniverse = {
          error: "locations_universe_failed",
          detail: err instanceof Error ? err.message : String(err),
        };
      }

      // OPE-526 — vendor-application capture, by intake lane.
      //
      // Exists because "shipped" and "working" were the same claim for five
      // weeks: OPE-198 wired the vendor-application family on three paths and
      // was reported as covering every intake path. Nothing measured it, so
      // the two paths it missed stayed at a hard zero and only surfaced when
      // someone ran the query by hand.
      //
      // Reported as a per-method breakdown rather than one percentage: a
      // single blended number would have stayed comfortable while an entire
      // lane wrote nothing. A lane at 0/n with n non-trivial is the signal.
      let vendorFieldCapture: unknown;
      try {
        vendorFieldCapture = await db
          .select({
            ingestion_method: events.ingestionMethod,
            events: sql<number>`COUNT(*)`,
            with_any_field: sql<number>`SUM(CASE WHEN ${events.applicationUrl} IS NOT NULL
              OR ${events.vendorFeeMinCents} IS NOT NULL
              OR ${events.applicationDeadline} IS NOT NULL
              OR ${events.applicationInstructions} IS NOT NULL THEN 1 ELSE 0 END)`,
            with_apply_url: sql<number>`SUM(CASE WHEN ${events.applicationUrl} IS NOT NULL THEN 1 ELSE 0 END)`,
            with_fee: sql<number>`SUM(CASE WHEN ${events.vendorFeeMinCents} IS NOT NULL THEN 1 ELSE 0 END)`,
            with_deadline: sql<number>`SUM(CASE WHEN ${events.applicationDeadline} IS NOT NULL THEN 1 ELSE 0 END)`,
          })
          .from(events)
          .where(
            and(
              isNull(events.mergedInto),
              gte(events.createdAt, new Date(Date.now() - VENDOR_CAPTURE_WINDOW_MS))
            )
          )
          .groupBy(events.ingestionMethod);
      } catch (err) {
        vendorFieldCapture = {
          error: "vendor_field_capture_failed",
          detail: err instanceof Error ? err.message : String(err),
        };
      }

      return {
        content: [
          jsonContent({
            generated_at: new Date().toISOString(),
            // OPE-526 — see the comment above the query. `ingestion_method` is
            // itself an imperfect instrument (OPE-486/OPE-491: it conflates
            // three questions and ~40% is a defaulted label), so read a lane at
            // zero as "go look at the code for that lane", not as a verdict.
            vendor_field_capture_90d: vendorFieldCapture,
            locations_universe: locationsUniverse,
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
            // OPE-472 — series parentage.
            //
            // Read `orphan_since_jul_with_venue` (should be 0) for "is the
            // write path holding", NOT the undifferentiated
            // `orphan_events_since_jul`, which legitimately climbs whenever a
            // venue-less event is created and is therefore useless as a
            // health signal on its own. `series_created_last_7d` and
            // `assigned_since_jul` are the positive liveness numbers; a
            // frozen `series_created_last_7d` is the real "writer is dead"
            // tell. The live-orphan backlog remains a separate (backfill)
            // question owned by OPE-473.
            series_invariants: seriesInvariants ?? null,
            // OPE-294 — the hotlink population, so "trends down" is checkable
            // rather than asserted. `venues_google_places` is the subset with a
            // licensing question attached.
            hotlinked_images: hotlinkedImages[0] ?? null,
            // OPE-404 — inbound emails terminally stuck on `status='failed'`.
            // `oldest_failed_days` is the actionable one: fixing a cause does
            // not move rows that already failed, and nothing else counts them.
            stuck_inbound_emails: stuckInbound ?? null,
            // OPE-510 — the two subscriber counts that must agree.
            //
            // `newsletter_list_subscriptions` shipped with no writer on the
            // signup path while the weekend broadcast switched to reading it,
            // so confirmed subscribers accumulated with no list row and got no
            // mail. It hid for ELEVEN DAYS because nothing compared the two
            // sides: the list had 17 members the morning of its backfill and
            // still had 17 a week later, and a number that never moves looks
            // exactly like a number nothing writes to.
            //
            // `orphaned` is the actionable figure and it counts PEOPLE, each of
            // whom completed double opt-in and is receiving nothing. It read 6
            // before the 08-21 backfill, 0 after, and 3 again two days later —
            // which is the whole argument for watching it continuously rather
            // than auditing it twice.
            newsletter_list_balance: {
              rule: "every confirmed, non-unsubscribed subscriber is on at least one active list",
              result: newsletterListBalance,
            },
            // OPE-292 — placeholder accounts must not pollute the
            // registration partition. `misfiled_placeholders` should be 0;
            // non-zero means some creation path stopped stamping `origin`.
            placeholder_origin: {
              rule: "no users row may be origin='registration' with a pending+ placeholder email",
              ...placeholderOrigin,
            },
            // OPE-278 item 3 — live `-N` slug pairs, the receipt dedup
            // leaves when it loses. Narrow by design: both rows live AND
            // start dates within 7 days, because 42 events carry a numeric
            // suffix and nearly all were already rejected by hand. See the
            // comment at the query for why the date guard is load-bearing.
            slug_collision_live_pairs: {
              rule: "no two LIVE events may differ only by a numeric slug suffix within 7 days of each other",
              ...slugCollisions,
            },
            // OPE-505 — the citation tool's midnight-anchor signature. Should
            // stay at whatever John rules on for the existing rows and never
            // grow; growth means a date writer bypassed normalizeEventDate again.
            split_date_anchor: {
              rule: "no event may have one date at midnight UTC and the other at noon UTC",
              violation_count: splitAnchorRows.length,
              violations: splitAnchorRows.map((r) => ({
                slug: r.slug,
                status: r.status,
                start_date: new Date(r.start_date * 1000).toISOString(),
                end_date: new Date(r.end_date * 1000).toISOString(),
              })),
            },
            // OPE-482 — see the comment at the query. Any non-zero column here
            // is a date rendering one day EARLY on a live page, because
            // date-only formatting is Eastern as of 2026-08-25.
            midnight_utc_date_anchors: {
              rule: "no live event may store a date at exactly 00:00:00Z — the noon anchor (normalizeEventDate) is the convention",
              violation_count: midnightAnchorTotal,
              by_column: {
                start_date: Number(midnightAnchors?.start_date ?? 0),
                end_date: Number(midnightAnchors?.end_date ?? 0),
                public_start_date: Number(midnightAnchors?.public_start_date ?? 0),
                public_end_date: Number(midnightAnchors?.public_end_date ?? 0),
                application_deadline: Number(midnightAnchors?.application_deadline ?? 0),
              },
            },
            // OPE-543 — see the comment at the query. Non-zero means the
            // public date band can disagree with the event's own dates, on a
            // surface no admin or vendor is served.
            public_date_derivation: {
              rule: "public_start_date/public_end_date are derived from event_days (minus vendor_only) — NULL when there are no days, never a copy of start_date",
              violation_count:
                Number(publicDateDerivation?.orphaned_copies ?? 0) +
                Number(publicDateDerivation?.stale_derivation ?? 0),
              orphaned_copies: Number(publicDateDerivation?.orphaned_copies ?? 0),
              stale_derivation: Number(publicDateDerivation?.stale_derivation ?? 0),
            },
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
