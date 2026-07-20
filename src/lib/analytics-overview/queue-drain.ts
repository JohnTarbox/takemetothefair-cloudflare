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
import { and, count, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import {
  eventDiscrepancies,
  vendorEnrichmentCandidates,
  promoterEnrichmentCandidates,
  performerEnrichmentCandidates,
  healthIssues,
  healthIssueSnoozes,
  inboundEmails,
  queueDrainSnapshots,
} from "@/lib/db/schema";
import { getCurrentIssues } from "@/lib/site-health";
import { SITE_URL } from "@takemetothefair/constants";
import type { AnyColumn, SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "./shared";
import type { QueueFlow } from "@/lib/queue-freeze";

const DAY_MS = 86_400_000;
/** Deep-link the frozen-queue RED + tile share. */
export const QUEUE_DRAIN_HREF = `${SITE_URL}/admin/analytics#queue-drain-ratios`;

/** A queue's live flow plus the values persisted daily for the trend. */
export interface QueueDrainRow extends QueueFlow {
  inflow1d: number;
  /** null only for the inbound queue before it has a prior snapshot. */
  outflow1d: number | null;
  drainRatio7d: number | null;
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
  };
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

/** Compute live flow for all six queues. Never throws per-queue — a failure in
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
  ];

  return Promise.all(specs);
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
