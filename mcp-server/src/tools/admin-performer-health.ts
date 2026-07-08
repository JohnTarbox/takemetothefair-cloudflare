/**
 * OPE-124 — performer appearance data-health guardrails.
 *
 * `get_performer_data_health` runs a set of cheap DB-side invariant checks over
 * performer appearance data and returns a grouped, actionable worklist (each
 * finding carries the offending entity IDs + a reason + a suggested action).
 * Read-only detection — never mutates. Same philosophy as the Site Health rework
 * (OPE-49): surface fixable defects, not noise.
 *
 * The design constraint is ZERO false-positives on clean data. Two places earn
 * their tolerances:
 *   - time-out-of-range uses a 2-day grace because events.end_date is stored as
 *     MIDNIGHT of the last day, so an act playing at 3pm on closing day is
 *     legitimately end_date + 15h. The 2-day window still catches gross
 *     wrong-month / wrong-year rollover errors (the actual failure mode).
 *   - stale-imminent-lineup only flags upcoming events that ALREADY have a
 *     lineup (≥1 CONFIRMED/PENDING appearance) — a brand-new event with no
 *     performers isn't an actionable "re-verify" target.
 *
 * The core (getPerformerDataHealth) is exported for direct test drive.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { events, eventPerformers, performers, eventDays } from "../schema.js";
import { jsonContent } from "../helpers.js";
import { findDuplicatePerformers } from "./admin-performer-discovery.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

const DAY = 86400; // seconds
/** end_date is midnight of the last day; 2 days clears the closing-day + TZ. */
const RANGE_GRACE = 2 * DAY;

export interface HealthCheck {
  key: string;
  title: string;
  suggested_action: string;
  count: number;
  findings: Array<Record<string, unknown>>;
}

export interface PerformerHealthReport {
  generated_at_epoch: number;
  params: { days_ahead: number; stale_days: number; duplicate_min_score: number; limit: number };
  total_findings: number;
  checks: HealthCheck[];
}

export async function getPerformerDataHealth(
  db: Db,
  opts: { daysAhead?: number; staleDays?: number; duplicateMinScore?: number; limit?: number } = {}
): Promise<PerformerHealthReport> {
  const daysAhead = opts.daysAhead ?? 7;
  const staleDays = opts.staleDays ?? 7;
  const duplicateMinScore = opts.duplicateMinScore ?? 0.9;
  const limit = opts.limit ?? 200;
  const now = Math.floor(Date.now() / 1000);

  // 1. Past-but-unresolved: event ended but the appearance is still PENDING.
  const pastPending = await db
    .select({
      appearance_id: eventPerformers.id,
      event_id: eventPerformers.eventId,
      performer_id: eventPerformers.performerId,
      event_slug: events.slug,
      end_date: events.endDate,
    })
    .from(eventPerformers)
    .innerJoin(events, eq(events.id, eventPerformers.eventId))
    .where(
      and(
        eq(eventPerformers.status, "PENDING"),
        isNotNull(events.endDate),
        lt(events.endDate, new Date(now * 1000)),
        isNull(events.mergedInto)
      )
    )
    .limit(limit);

  // 2. Time out of range: performance time > 2 days outside the event window
  //    (catches wrong-month/year rollover; tolerant of legit same-day times).
  const outOfRange = await db
    .select({
      appearance_id: eventPerformers.id,
      event_id: eventPerformers.eventId,
      event_slug: events.slug,
      performance_start: eventPerformers.performanceStart,
      performance_end: eventPerformers.performanceEnd,
      start_date: events.startDate,
      end_date: events.endDate,
    })
    .from(eventPerformers)
    .innerJoin(events, eq(events.id, eventPerformers.eventId))
    .where(
      and(
        isNotNull(events.startDate),
        isNotNull(events.endDate),
        or(
          sql`${eventPerformers.performanceStart} IS NOT NULL AND (${eventPerformers.performanceStart} < ${events.startDate} - ${RANGE_GRACE} OR ${eventPerformers.performanceStart} > ${events.endDate} + ${RANGE_GRACE})`,
          sql`${eventPerformers.performanceEnd} IS NOT NULL AND (${eventPerformers.performanceEnd} < ${events.startDate} - ${RANGE_GRACE} OR ${eventPerformers.performanceEnd} > ${events.endDate} + ${RANGE_GRACE})`
        )
      )
    )
    .limit(limit);

  // 3. Stale imminent lineup: upcoming events (next N days) that HAVE a lineup
  //    but whose roster hasn't been re-checked recently (OPE-123 fields).
  const staleCutoff = new Date((now - staleDays * DAY) * 1000);
  const staleImminent = await db
    .select({
      event_id: events.id,
      event_slug: events.slug,
      start_date: events.startDate,
      roster_checked_at: events.performerRosterCheckedAt,
      roster_status: events.performerRosterStatus,
    })
    .from(events)
    .where(
      and(
        isNotNull(events.startDate),
        sql`${events.startDate} >= ${now} AND ${events.startDate} <= ${now + daysAhead * DAY}`,
        isNull(events.mergedInto),
        or(
          isNull(events.performerRosterCheckedAt),
          lt(events.performerRosterCheckedAt, staleCutoff)
        ),
        sql`EXISTS (SELECT 1 FROM event_performers ep WHERE ep.event_id = ${events.id} AND ep.status IN ('CONFIRMED','PENDING'))`
      )
    )
    .limit(limit);

  // 4a. Orphaned: appearance points at a soft-deleted / merged performer.
  const orphanPerformer = await db
    .select({
      appearance_id: eventPerformers.id,
      event_id: eventPerformers.eventId,
      performer_id: eventPerformers.performerId,
      performer_slug: performers.slug,
    })
    .from(eventPerformers)
    .innerJoin(performers, eq(performers.id, eventPerformers.performerId))
    .where(or(isNotNull(performers.deletedAt), isNotNull(performers.redirectToPerformerId)))
    .limit(limit);

  // 4b. Orphaned: appearance points at a merged event (tombstone).
  const orphanEvent = await db
    .select({
      appearance_id: eventPerformers.id,
      event_id: eventPerformers.eventId,
      merged_into: events.mergedInto,
    })
    .from(eventPerformers)
    .innerJoin(events, eq(events.id, eventPerformers.eventId))
    .where(isNotNull(events.mergedInto))
    .limit(limit);

  // 5. Missing provenance: CONFIRMED appearance with no source_url.
  const missingProvenance = await db
    .select({
      appearance_id: eventPerformers.id,
      event_id: eventPerformers.eventId,
      performer_id: eventPerformers.performerId,
    })
    .from(eventPerformers)
    .where(
      and(
        eq(eventPerformers.status, "CONFIRMED"),
        sql`(${eventPerformers.sourceUrl} IS NULL OR TRIM(${eventPerformers.sourceUrl}) = '')`
      )
    )
    .limit(limit);

  // 6. Duplicate performers — reuse the OPE-116 sweep.
  const dup = await findDuplicatePerformers(db, { minScore: duplicateMinScore });
  const duplicates = dup.pairs.slice(0, limit).map((p) => ({
    performer_a: { id: p.a.id, name: p.a.name, slug: p.a.slug },
    performer_b: { id: p.b.id, name: p.b.name, slug: p.b.slug },
    score: Number(p.score.toFixed(3)),
  }));

  // 7. Cross-year carry: appearance whose event_day belongs to a DIFFERENT event.
  const crossYear = await db
    .select({
      appearance_id: eventPerformers.id,
      event_id: eventPerformers.eventId,
      event_day_id: eventPerformers.eventDayId,
      day_event_id: eventDays.eventId,
      day_date: eventDays.date,
    })
    .from(eventPerformers)
    .innerJoin(eventDays, eq(eventDays.id, eventPerformers.eventDayId))
    .where(
      and(
        isNotNull(eventPerformers.eventDayId),
        sql`${eventDays.eventId} <> ${eventPerformers.eventId}`
      )
    )
    .limit(limit);

  const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d);
  const checks: HealthCheck[] = [
    {
      key: "past_but_pending",
      title: "Past event, appearance still PENDING",
      suggested_action:
        "Resolve to CONFIRMED (it happened) or CANCELLED via set_event_performer_status.",
      count: pastPending.length,
      findings: pastPending.map((r) => ({ ...r, end_date: iso(r.end_date) })),
    },
    {
      key: "time_out_of_range",
      title: "Performance time outside the event window (±2d)",
      suggested_action:
        "Fix the slot time via set_event_performer_slot — likely a wrong-month/year data-entry error.",
      count: outOfRange.length,
      findings: outOfRange.map((r) => ({
        ...r,
        performance_start: iso(r.performance_start),
        performance_end: iso(r.performance_end),
        start_date: iso(r.start_date),
        end_date: iso(r.end_date),
      })),
    },
    {
      key: "stale_imminent_lineup",
      title: `Upcoming event (≤${daysAhead}d) with a lineup not re-verified in ${staleDays}d`,
      suggested_action:
        "Re-ground the lineup against its source, then set_performer_roster_status VERIFIED.",
      count: staleImminent.length,
      findings: staleImminent.map((r) => ({
        ...r,
        start_date: iso(r.start_date),
        roster_checked_at: iso(r.roster_checked_at),
      })),
    },
    {
      key: "orphaned_appearance",
      title: "Appearance points at a deleted/merged performer or a merged event",
      suggested_action:
        "Re-point to the keeper performer, or delete the dangling appearance (merge should have moved it).",
      count: orphanPerformer.length + orphanEvent.length,
      findings: [
        ...orphanPerformer.map((r) => ({ ...r, kind: "performer_tombstone" })),
        ...orphanEvent.map((r) => ({ ...r, kind: "event_merged" })),
      ],
    },
    {
      key: "missing_provenance",
      title: "CONFIRMED appearance with no source_url",
      suggested_action:
        "Add the source it was learned from (needed to re-verify) via the appearance's source_url.",
      count: missingProvenance.length,
      findings: missingProvenance,
    },
    {
      key: "duplicate_performers",
      title: "Likely-duplicate performer records not yet merged",
      suggested_action:
        "Collapse via merge_performer(keeper_id, duplicate_id) — keep the fuller record.",
      count: duplicates.length,
      findings: duplicates,
    },
    {
      key: "cross_year_carry",
      title: "Appearance attached to an event_day of a DIFFERENT event",
      suggested_action:
        "Re-point event_day_id (or clear it) via set_event_performer_slot — never carry a set across occurrences.",
      count: crossYear.length,
      findings: crossYear,
    },
  ];

  return {
    generated_at_epoch: now,
    params: {
      days_ahead: daysAhead,
      stale_days: staleDays,
      duplicate_min_score: duplicateMinScore,
      limit,
    },
    total_findings: checks.reduce((s, c) => s + c.count, 0),
    checks,
  };
}

export function registerPerformerHealthTool(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "get_performer_data_health",
    "Read-only performer-appearance data-health report (OPE-124). Runs 7 invariant checks and returns findings grouped by check, each with entity IDs + reason + suggested action: (1) past event still PENDING, (2) performance time outside the event window (±2d grace), (3) upcoming event (≤days_ahead) with a lineup not re-verified in stale_days, (4) appearance pointing at a deleted/merged performer or merged event, (5) CONFIRMED appearance with no source_url, (6) likely-duplicate performers, (7) appearance attached to an event_day of a different event. Never mutates — produces a worklist for the re-verification drain. Admin only.",
    {
      days_ahead: z
        .number()
        .int()
        .min(1)
        .max(90)
        .optional()
        .default(7)
        .describe("Look-ahead window for the stale-imminent-lineup check (default 7)."),
      stale_days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .default(7)
        .describe("A roster checked longer ago than this is 'stale' (default 7)."),
      duplicate_min_score: z
        .number()
        .min(0.5)
        .max(1)
        .optional()
        .default(0.9)
        .describe("Min fuzzy score for the duplicate-performers check (default 0.9)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(200)
        .describe("Max findings per check (default 200)."),
    },
    async (params) => {
      const report = await getPerformerDataHealth(db, {
        daysAhead: params.days_ahead,
        staleDays: params.stale_days,
        duplicateMinScore: params.duplicate_min_score,
        limit: params.limit,
      });
      return { content: [jsonContent(report)] };
    }
  );
}
