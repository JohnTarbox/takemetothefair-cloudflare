/**
 * OPE-247 — per-queue inflow/outflow/depth/drain-ratio for the six work queues,
 * plus daily-snapshot persistence.
 *
 * Shared by (a) the /admin/analytics tile (live read) and (b) the daily
 * stale-red scan (persist + feed the frozen-queue RED). One computation path so
 * the tile, the trend, and the alert never disagree.
 *
 * Five of the six queues expose a decided-at timestamp, so their outflow over
 * any trailing window is a direct count. The inbound exception queue
 * (`inbound_emails.flagged_for_review`) has NO handled-at stamp, so its outflow
 * is recovered as a day-over-day depth delta from the persisted snapshots — and
 * stays `null` (→ no RED, tile shows "pending history") until a prior row exists.
 */
import { and, count, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import {
  eventDiscrepancies,
  supportObligations,
  vendorEnrichmentCandidates,
  promoterEnrichmentCandidates,
  performerEnrichmentCandidates,
  healthIssues,
  healthIssueSnoozes,
  inboundEmails,
  venues,
  queueDrainSnapshots,
} from "@/lib/db/schema";
import { getCurrentIssues } from "@/lib/site-health";
import { SITE_URL } from "@takemetothefair/constants";
import type { AnyColumn, SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { assessQueueFreeze, type QueueFlow } from "@/lib/queue-freeze";
import type { Db } from "./shared";
import type { QueueDrainCard } from "./types";

const DAY_MS = 86_400_000;
/** Deep-link the frozen-queue RED + tile share. */
export const QUEUE_DRAIN_HREF = `${SITE_URL}/admin/analytics#queue-drain-ratios`;

/** A queue's live flow plus the values persisted daily for the trend. */
export interface QueueDrainRow extends QueueFlow {
  inflow1d: number;
  /** null only for the inbound queue before it has a prior snapshot. */
  outflow1d: number | null;
  drainRatio7d: number | null;
  /**
   * OPE-373 — open depth split by defect class, most numerous first.
   *
   * The Monday inventory has reported `site_health: 324` since it was built and
   * that number has never once been actionable, because it summed populations
   * that demand completely different responses: a 5xx someone must fix today,
   * a page Google merely chose not to index, and (until OPE-372) URLs we never
   * published at all. A single total across incommensurable buckets is not a
   * measurement, it is an average of apples and Tuesdays.
   *
   * Only populated for queues where the split is meaningful; undefined elsewhere.
   */
  buckets?: Array<{ label: string; count: number; severity: string }>;
}

function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function cnt(db: Db, table: SQLiteTable, where: SQL | undefined): Promise<number> {
  const [r] = await db.select({ n: count() }).from(table).where(where);
  return Number(r?.n ?? 0);
}

function ratio(outflow7d: number | null, inflow7d: number): number | null {
  if (outflow7d === null || inflow7d <= 0) return null;
  return outflow7d / inflow7d;
}

/**
 * A queue whose inflow and outflow are both readable as row-timestamp counts
 * (discrepancies + the three enrichment queues). `openWhere` defines depth.
 */
async function timestampQueueFlow(
  db: Db,
  now: Date,
  spec: {
    queueName: string;
    label: string;
    table: SQLiteTable;
    createdCol: AnyColumn;
    decidedCol: AnyColumn; // set only when decided → gte implies decided
    openWhere: SQL;
  }
): Promise<QueueDrainRow> {
  const d = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const [depth, inflow1d, inflow7d, inflow14d, outflow1d, outflow7d, outflow14d] =
    await Promise.all([
      cnt(db, spec.table, spec.openWhere),
      cnt(db, spec.table, gte(spec.createdCol, d(1))),
      cnt(db, spec.table, gte(spec.createdCol, d(7))),
      cnt(db, spec.table, gte(spec.createdCol, d(14))),
      cnt(db, spec.table, gte(spec.decidedCol, d(1))),
      cnt(db, spec.table, gte(spec.decidedCol, d(7))),
      cnt(db, spec.table, gte(spec.decidedCol, d(14))),
    ]);
  const [oldest] = await db
    .select({ t: sql<number>`min(${spec.createdCol})` })
    .from(spec.table)
    .where(spec.openWhere);
  const oldestOpenAgeHours =
    oldest?.t != null ? (now.getTime() - Number(oldest.t) * 1000) / 3_600_000 : null;

  return {
    queueName: spec.queueName,
    label: spec.label,
    href: QUEUE_DRAIN_HREF,
    depth,
    inflow7d,
    outflow7d,
    inflow14d,
    outflow14d,
    oldestOpenAgeHours,
    inflow1d,
    outflow1d,
    drainRatio7d: ratio(outflow7d, inflow7d),
  };
}

/** Site-health: depth reconciles with the Site-Health tile (`hideSnoozed:true`);
 *  outflow = issues resolved OR snoozed in the window. */
async function siteHealthFlow(db: Db, now: Date): Promise<QueueDrainRow> {
  const d = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const open = await getCurrentIssues(db, { hideSnoozed: true });
  const depth = open.length;

  const resolvedIn = (since: Date) =>
    cnt(
      db,
      healthIssues,
      and(isNotNull(healthIssues.resolvedAt), gte(healthIssues.resolvedAt, since))
    );
  const snoozedIn = (since: Date) =>
    cnt(db, healthIssueSnoozes, gte(healthIssueSnoozes.snoozedAt, since));
  const outflowIn = async (since: Date) => (await resolvedIn(since)) + (await snoozedIn(since));

  const [inflow1d, inflow7d, inflow14d, outflow1d, outflow7d, outflow14d] = await Promise.all([
    cnt(db, healthIssues, gte(healthIssues.firstDetectedAt, d(1))),
    cnt(db, healthIssues, gte(healthIssues.firstDetectedAt, d(7))),
    cnt(db, healthIssues, gte(healthIssues.firstDetectedAt, d(14))),
    outflowIn(d(1)),
    outflowIn(d(7)),
    outflowIn(d(14)),
  ]);
  const oldestOpenAgeHours = open.reduce<number | null>((acc, i) => {
    const t = i.firstDetectedAt instanceof Date ? i.firstDetectedAt.getTime() : null;
    if (t == null) return acc;
    const h = (now.getTime() - t) / 3_600_000;
    return acc == null || h > acc ? h : acc;
  }, null);

  // OPE-373 item 3 — report by bucket, never as a bare total. Grouped on the
  // `message` (GSC coverage state), which is the field that actually determines
  // what, if anything, a human should do about the row.
  const byMessage = new Map<string, { count: number; severity: string }>();
  for (const issue of open) {
    const key = issue.message ?? issue.issueType ?? "(unclassified)";
    const prev = byMessage.get(key);
    byMessage.set(key, {
      count: (prev?.count ?? 0) + 1,
      // Worst severity wins within a bucket, so a mixed bucket cannot be
      // read as calmer than its most serious member.
      severity:
        severityRank(issue.severity) > severityRank(prev?.severity)
          ? issue.severity
          : (prev?.severity ?? issue.severity),
    });
  }
  const buckets = [...byMessage.entries()]
    .map(([label, v]) => ({ label, count: v.count, severity: v.severity }))
    .sort((a, b) => b.count - a.count);

  return {
    queueName: "site_health",
    label: "Site-health issues",
    href: QUEUE_DRAIN_HREF,
    depth,
    inflow7d,
    outflow7d,
    inflow14d,
    outflow14d,
    oldestOpenAgeHours,
    inflow1d,
    outflow1d,
    drainRatio7d: ratio(outflow7d, inflow7d),
    buckets,
  };
}

/** ERROR > WARNING > INFO > anything else. Used to pick a bucket's severity. */
function severityRank(severity: string | undefined): number {
  switch ((severity ?? "").toUpperCase()) {
    case "ERROR":
      return 3;
    case "WARNING":
      return 2;
    case "INFO":
      return 1;
    default:
      return 0;
  }
}

/** Inbound exception queue (`flagged_for_review=1`). Outflow is not
 *  timestamp-derivable — recovered from persisted snapshot deltas. */
async function inboundExceptionFlow(db: Db, now: Date): Promise<QueueDrainRow> {
  const d = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const flagged = eq(inboundEmails.flaggedForReview, 1);
  const [depth, inflow1d, inflow7d, inflow14d] = await Promise.all([
    cnt(db, inboundEmails, flagged),
    cnt(db, inboundEmails, and(flagged, gte(inboundEmails.receivedAt, d(1)))),
    cnt(db, inboundEmails, and(flagged, gte(inboundEmails.receivedAt, d(7)))),
    cnt(db, inboundEmails, and(flagged, gte(inboundEmails.receivedAt, d(14)))),
  ]);

  // Outflow via depth deltas from persisted history: outflow_1d today =
  // max(0, yesterday_depth + inflow_1d − depth). Window outflow = Σ stored
  // outflow_1d over the last N snapshots. Null (→ no RED) until history exists.
  const prior = await db
    .select({
      depth: queueDrainSnapshots.depth,
      outflow1d: queueDrainSnapshots.outflow1d,
      snapshotDate: queueDrainSnapshots.snapshotDate,
    })
    .from(queueDrainSnapshots)
    .where(
      and(
        eq(queueDrainSnapshots.queueName, "inbound_exceptions"),
        lt(queueDrainSnapshots.snapshotDate, utcDate(now))
      )
    )
    .orderBy(sql`${queueDrainSnapshots.snapshotDate} desc`)
    .limit(14);

  const outflow1d = prior.length > 0 ? Math.max(0, prior[0].depth + inflow1d - depth) : null;
  const sumStored = (n: number): number | null => {
    const rows = prior.slice(0, n).filter((r) => r.outflow1d != null);
    if (rows.length === 0) return null;
    const stored = rows.reduce((s, r) => s + (r.outflow1d as number), 0);
    return stored + (outflow1d ?? 0);
  };
  const outflow7d = sumStored(6); // 6 prior + today ≈ 7d
  const outflow14d = sumStored(13);

  return {
    queueName: "inbound_exceptions",
    label: "Inbound exception queue",
    href: QUEUE_DRAIN_HREF,
    depth,
    inflow7d,
    outflow7d,
    inflow14d,
    outflow14d,
    oldestOpenAgeHours: null,
    inflow1d,
    outflow1d,
    drainRatio7d: ratio(outflow7d, inflow7d),
  };
}

/**
 * OPE-387 — inbound emails paused for an admin decision (`status='waiting'`).
 *
 * `waiting` is not an error state, it is the human-in-the-loop pause the
 * inbound workflow enters for `correction` / `press` / `claim_request`: the
 * handler ran, `mark-waiting` set the status, and the workflow is hibernating on
 * `waitForEvent("admin-decision", 7 days)`.
 *
 * The defect it was invisible to: **nothing counted it**. The inbound exception
 * queue above tracks `flagged_for_review=1` only, and a waiting row is not
 * flagged. So a real customer correction (Paradise City Arts, 2026-08-13 —
 * wrong festival dates on a live listing) sat in a queue with no depth, no age
 * and no owner. After 7 days `waitForEvent` times out, `decision` falls through
 * as null, and the sender gets a GENERIC ACK — the correction silently never
 * happens, which is the "reports success, does nothing" family.
 *
 * Unlike its sibling this reports `oldestOpenAgeHours`, and that is the point:
 * depth alone cannot show a row approaching a 168-hour cliff, and the cliff is
 * where the data loss occurs.
 */
async function inboundAwaitingDecisionFlow(db: Db, now: Date): Promise<QueueDrainRow> {
  const d = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const waiting = eq(inboundEmails.status, "waiting");
  const [depth, inflow1d, inflow7d, inflow14d, oldest] = await Promise.all([
    cnt(db, inboundEmails, waiting),
    cnt(db, inboundEmails, and(waiting, gte(inboundEmails.receivedAt, d(1)))),
    cnt(db, inboundEmails, and(waiting, gte(inboundEmails.receivedAt, d(7)))),
    cnt(db, inboundEmails, and(waiting, gte(inboundEmails.receivedAt, d(14)))),
    db
      .select({ oldest: sql<number | null>`min(${inboundEmails.receivedAt})` })
      .from(inboundEmails)
      .where(waiting),
  ]);

  const oldestSec = oldest[0]?.oldest ?? null;
  const oldestOpenAgeHours =
    oldestSec != null ? (now.getTime() / 1000 - Number(oldestSec)) / 3600 : null;

  const prior = await db
    .select({
      depth: queueDrainSnapshots.depth,
      outflow1d: queueDrainSnapshots.outflow1d,
      snapshotDate: queueDrainSnapshots.snapshotDate,
    })
    .from(queueDrainSnapshots)
    .where(
      and(
        eq(queueDrainSnapshots.queueName, "inbound_awaiting_decision"),
        lt(queueDrainSnapshots.snapshotDate, utcDate(now))
      )
    )
    .orderBy(sql`${queueDrainSnapshots.snapshotDate} desc`)
    .limit(14);

  const outflow1d = prior.length > 0 ? Math.max(0, prior[0].depth + inflow1d - depth) : null;
  const sumStored = (n: number): number | null => {
    const rows = prior.slice(0, n).filter((r) => r.outflow1d != null);
    if (rows.length === 0) return null;
    const stored = rows.reduce((s, r) => s + (r.outflow1d as number), 0);
    return stored + (outflow1d ?? 0);
  };

  return {
    queueName: "inbound_awaiting_decision",
    label: "Inbound awaiting admin decision",
    href: QUEUE_DRAIN_HREF,
    depth,
    inflow7d,
    outflow7d: sumStored(6),
    inflow14d,
    outflow14d: sumStored(13),
    oldestOpenAgeHours,
    inflow1d,
    outflow1d,
    drainRatio7d: ratio(sumStored(6), inflow7d),
  };
}

/**
 * OPE-408 — venues with no coordinates.
 *
 * `venues_geocode` shipped (OPE-207) "for batch backfill AND every future new
 * venue"; only the backfill half was wired, so pins appeared only when a human
 * remembered. Missing-coords went 0% (Jan–Apr) -> 52% (Aug), and that curve is
 * not decaying data quality — it is TIME SINCE THE LAST MANUAL SWEEP.
 *
 * The failure was not that geocoding broke. It was that nobody could see it
 * drifting, which is why this belongs in the inventory rather than in a
 * one-off report: a venue with no pin silently breaks photo matching,
 * distance/near-me and every map surface.
 *
 * `oldestOpenAgeHours` is the load-bearing column. Depth alone cannot separate
 * "25 venues created today, sweep runs at 08:30" from "25 venues that have sat
 * unpinned since May" — the first is healthy, the second is the drift.
 *
 * Outflow is a snapshot delta: geocoding fills columns in place and stamps no
 * "geocoded_at", so there is no timestamp to count. Null until history exists.
 */
async function venuesMissingCoordsFlow(db: Db, now: Date): Promise<QueueDrainRow> {
  const d = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const missing = and(isNull(venues.latitude), isNull(venues.longitude));
  const [depth, inflow1d, inflow7d, inflow14d, oldest] = await Promise.all([
    cnt(db, venues, missing),
    cnt(db, venues, and(missing, gte(venues.createdAt, d(1)))),
    cnt(db, venues, and(missing, gte(venues.createdAt, d(7)))),
    cnt(db, venues, and(missing, gte(venues.createdAt, d(14)))),
    db
      .select({ oldest: sql<number | null>`min(${venues.createdAt})` })
      .from(venues)
      .where(missing),
  ]);

  const oldestSec = oldest[0]?.oldest ?? null;
  const oldestOpenAgeHours =
    oldestSec != null ? (now.getTime() / 1000 - Number(oldestSec)) / 3600 : null;

  const prior = await db
    .select({
      depth: queueDrainSnapshots.depth,
      outflow1d: queueDrainSnapshots.outflow1d,
      snapshotDate: queueDrainSnapshots.snapshotDate,
    })
    .from(queueDrainSnapshots)
    .where(
      and(
        eq(queueDrainSnapshots.queueName, "venues_missing_coords"),
        lt(queueDrainSnapshots.snapshotDate, utcDate(now))
      )
    )
    .orderBy(sql`${queueDrainSnapshots.snapshotDate} desc`)
    .limit(14);

  const outflow1d = prior.length > 0 ? Math.max(0, prior[0].depth + inflow1d - depth) : null;
  const sumStored = (n: number): number | null => {
    const rows = prior.slice(0, n).filter((r) => r.outflow1d != null);
    if (rows.length === 0) return null;
    return rows.reduce((s, r) => s + (r.outflow1d as number), 0) + (outflow1d ?? 0);
  };

  return {
    queueName: "venues_missing_coords",
    label: "Venues missing coordinates",
    href: QUEUE_DRAIN_HREF,
    depth,
    inflow7d,
    outflow7d: sumStored(6),
    inflow14d,
    outflow14d: sumStored(13),
    oldestOpenAgeHours,
    inflow1d,
    outflow1d,
    drainRatio7d: ratio(sumStored(6), inflow7d),
  };
}

/** Compute live flow for all seven queues. Never throws per-queue — a failure in
 *  one returns a depth-0 placeholder so the others still render/alert. */
export async function gatherQueueFlows(db: Db, now: Date): Promise<QueueDrainRow[]> {
  const enrichment = (
    queueName: string,
    label: string,
    table: SQLiteTable,
    createdCol: AnyColumn,
    decidedCol: AnyColumn,
    decisionCol: AnyColumn
  ) =>
    timestampQueueFlow(db, now, {
      queueName,
      label,
      table,
      createdCol,
      decidedCol,
      openWhere: eq(decisionCol, "pending"),
    });

  const specs: Array<Promise<QueueDrainRow>> = [
    timestampQueueFlow(db, now, {
      queueName: "event_discrepancies",
      label: "Event discrepancies",
      table: eventDiscrepancies,
      createdCol: eventDiscrepancies.detectedAt,
      decidedCol: eventDiscrepancies.resolvedAt,
      openWhere: eq(eventDiscrepancies.resolutionStatus, "open"),
    }),
    enrichment(
      "vendor_enrichment",
      "Vendor enrichment review",
      vendorEnrichmentCandidates,
      vendorEnrichmentCandidates.createdAt,
      vendorEnrichmentCandidates.reviewedAt,
      vendorEnrichmentCandidates.decision
    ),
    enrichment(
      "promoter_enrichment",
      "Promoter enrichment review",
      promoterEnrichmentCandidates,
      promoterEnrichmentCandidates.createdAt,
      promoterEnrichmentCandidates.reviewedAt,
      promoterEnrichmentCandidates.decision
    ),
    enrichment(
      "performer_enrichment",
      "Performer enrichment review",
      performerEnrichmentCandidates,
      performerEnrichmentCandidates.createdAt,
      performerEnrichmentCandidates.reviewedAt,
      performerEnrichmentCandidates.decision
    ),
    siteHealthFlow(db, now),
    inboundExceptionFlow(db, now),
    // OPE-387 — inbound emails paused on `waitForEvent("admin-decision")`.
    // Distinct from BOTH neighbours: inbound_exceptions counts classifier
    // UNCERTAINTY, support_obligations counts a promised human reply. This
    // counts a workflow literally hibernating for a decision — confidently
    // classified, handler ran, and invisible in every existing queue until now.
    inboundAwaitingDecisionFlow(db, now),
    // OPE-408 — coverage gap, not a work queue: rows nobody has to action, but
    // whose depth+age is the only visible signal that geocoding has drifted.
    venuesMissingCoordsFlow(db, now),
    // OPE-365 (R1) — people owed a human response. Distinct from
    // inbound_exceptions, which counts classifier UNCERTAINTY: that queue has
    // held depth 33 with outflow_1d=0 while a real customer's blocker passed
    // through unrecorded because the classifier was confident about it.
    timestampQueueFlow(db, now, {
      queueName: "support_obligations",
      label: "Support obligations (human owes a reply)",
      table: supportObligations,
      createdCol: supportObligations.openedAt,
      decidedCol: supportObligations.closedAt,
      openWhere: eq(supportObligations.status, "open"),
    }),
  ];

  return Promise.all(specs);
}

/** Tile loader — live per-queue flow + a `frozen` flag (via the same detector
 *  the alert uses, so the tile's red rows match the digest). */
export async function loadQueueDrain(db: Db): Promise<QueueDrainCard> {
  const now = new Date();
  const flows = await gatherQueueFlows(db, now);
  return {
    queues: flows.map((f) => ({
      queueName: f.queueName,
      label: f.label,
      depth: f.depth,
      inflow7d: f.inflow7d,
      outflow7d: f.outflow7d,
      drainRatio7d: f.drainRatio7d,
      frozen: assessQueueFreeze(f, now) !== null,
    })),
  };
}

/** UPSERT today's snapshot for each queue (idempotent on (queue_name, date)). */
export async function persistQueueSnapshots(
  db: Db,
  rows: QueueDrainRow[],
  now: Date
): Promise<void> {
  const snapshotDate = utcDate(now);
  for (const r of rows) {
    await db
      .insert(queueDrainSnapshots)
      .values({
        queueName: r.queueName,
        snapshotDate,
        depth: r.depth,
        inflow1d: r.inflow1d,
        outflow1d: r.outflow1d,
        drainRatio7d: r.drainRatio7d,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [queueDrainSnapshots.queueName, queueDrainSnapshots.snapshotDate],
        set: {
          depth: r.depth,
          inflow1d: r.inflow1d,
          outflow1d: r.outflow1d,
          drainRatio7d: r.drainRatio7d,
        },
      });
  }
}
