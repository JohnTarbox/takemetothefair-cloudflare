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
import { and, count, eq, gte, inArray, isNotNull, isNull, like, lt, not, sql } from "drizzle-orm";
import {
  DEFAULT_VERIFICATION_GRACE_HOURS,
  loadVerificationGraceHours,
} from "@/lib/verification-threshold";
import {
  emailSendLedger,
  emailDeliveryEvents,
  events,
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
  promoters,
  users,
} from "@/lib/db/schema";
import { getCurrentIssues } from "@/lib/site-health";
import {
  SITE_URL,
  TERMINAL_UNHANDLED_REPLY_KINDS,
  DISPOSED_INBOUND_STATUSES,
} from "@takemetothefair/constants";
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
 * OPE-532 — inbound submissions that ended in an acknowledgement rather than
 * an action.
 *
 * When the photo lane cannot resolve a fair it sends the "which fair?" reply
 * and writes `status='replied'` — the same status a fully successful
 * submission gets. So the row records its own failure as a success, and every
 * counter downstream reads it as handled.
 *
 * It was invisible to all three of its neighbours, which is why ten losses
 * inside eighteen minutes on 2026-08-23 produced no alert of any kind:
 *
 *   inbound_exceptions        counts `flagged_for_review=1`. All 9 live held
 *                             rows are `flagged_for_review=0` — verified in
 *                             prod, not assumed.
 *   inbound_awaiting_decision counts `status='waiting'`. These say 'replied'.
 *   OPE-17's triage notice     required `status='failed'` AND a submission
 *                             intent. A held photo fails BOTH.
 *
 * `oldestOpenAgeHours` is reported, like its OPE-387 sibling and for the same
 * reason: depth alone cannot show that the oldest of these has been sitting
 * since 2026-07-17. Nothing here times out on its own, so age is the only
 * signal that the queue has stopped moving.
 */
async function inboundHeldSubmissionFlow(db: Db, now: Date): Promise<QueueDrainRow> {
  const d = (days: number) => new Date(now.getTime() - days * DAY_MS);
  // Same three clauses as the MCP Worker's `salvageCandidateWhere` branch (B),
  // over the SAME shared constants, so the operator email and this tile cannot
  // disagree about what is held.
  const held = and(
    isNull(inboundEmails.resultingEventId),
    inArray(inboundEmails.replyKind, [...TERMINAL_UNHANDLED_REPLY_KINDS]),
    not(inArray(inboundEmails.status, [...DISPOSED_INBOUND_STATUSES]))
  );
  const [depth, inflow1d, inflow7d, inflow14d, oldest] = await Promise.all([
    cnt(db, inboundEmails, held),
    cnt(db, inboundEmails, and(held, gte(inboundEmails.receivedAt, d(1)))),
    cnt(db, inboundEmails, and(held, gte(inboundEmails.receivedAt, d(7)))),
    cnt(db, inboundEmails, and(held, gte(inboundEmails.receivedAt, d(14)))),
    db
      .select({ oldest: sql<number | null>`min(${inboundEmails.receivedAt})` })
      .from(inboundEmails)
      .where(held),
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
        eq(queueDrainSnapshots.queueName, "inbound_held_submissions"),
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
    queueName: "inbound_held_submissions",
    label: "Inbound submissions held (acked, never actioned)",
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
 * OPE-413 — the PENDING submissions queue.
 *
 * Every other queue in this inventory is internal. This one is different in
 * kind: a stalled row is a promise broken to a named member of the public, and
 * several rows sat here until the fair they described had already happened.
 * It reached 138 days with nobody watching, which is precisely the drainage-vs-
 * detection blindness OPE-247 named.
 *
 * `oldestOpenAgeHours` is the load-bearing column, as it was for OPE-408: depth
 * alone cannot separate "9 submissions arrived this week" from "9 submissions
 * have been sitting since May", and only the second is a failure.
 *
 * Outflow IS computable here, unlike some siblings — a submission leaves the
 * queue by changing status, and `updated_at` is a reliable change signal since
 * OPE-308 (2026-08-04). Before that date it was not, so the window is
 * deliberately the trailing one rather than all-time.
 */
async function pendingSubmissionsFlow(db: Db, now: Date): Promise<QueueDrainRow> {
  const d = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const isPending = and(eq(events.status, "PENDING"), isNull(events.mergedInto));
  const leftQueue = (since: Date) =>
    cnt(
      db,
      events,
      and(
        sql`${events.status} != 'PENDING'`,
        gte(events.updatedAt, since),
        sql`${events.sourceName} IN ('community-suggestion','email-submission','vendor-submission')`
      )
    );

  const [depth, inflow1d, inflow7d, inflow14d, outflow1d, outflow7d, outflow14d, oldest] =
    await Promise.all([
      cnt(db, events, isPending),
      cnt(db, events, and(isPending, gte(events.createdAt, d(1)))),
      cnt(db, events, and(isPending, gte(events.createdAt, d(7)))),
      cnt(db, events, and(isPending, gte(events.createdAt, d(14)))),
      leftQueue(d(1)),
      leftQueue(d(7)),
      leftQueue(d(14)),
      db
        .select({ oldest: sql<number | null>`min(${events.createdAt})` })
        .from(events)
        .where(isPending),
    ]);

  const oldestSec = oldest[0]?.oldest ?? null;
  return {
    queueName: "pending_submissions",
    label: "Submissions awaiting review (people waiting)",
    href: QUEUE_DRAIN_HREF,
    depth,
    inflow7d,
    outflow7d,
    inflow14d,
    outflow14d,
    oldestOpenAgeHours:
      oldestSec != null ? (now.getTime() / 1000 - Number(oldestSec)) / 3600 : null,
    inflow1d,
    outflow1d,
    drainRatio7d: ratio(outflow7d, inflow7d),
  };
}

/**
 * OPE-177 — auth/verification mail that did NOT reach the recipient.
 *
 * The case this exists for: a vendor registered, asked for the confirmation
 * email three times, got none, and emailed support. All three sends read
 * `status='sent'` with no error, because `sent` has only ever meant "the
 * provider accepted it". Her account sat unverifiable and nothing anywhere
 * counted the failure — there was no failure to count, only an absence.
 *
 * Depth = auth-source sends whose delivery event says the recipient never got
 * it (bounced / rejected / failed). Not deferred: a deferral is mid-retry and
 * counting it would flag mail that arrives twenty minutes later.
 *
 * ── The window is SELF-GATING, and that is the load-bearing part ────────────
 * Every send predating the event subscription has `delivery_status = NULL`,
 * which is "no signal", NOT "undelivered". A naive query would therefore report
 * every historical row as a failure on day one and be muted by the end of the
 * week. So the window starts at the FIRST delivery event we ever received: no
 * events yet → empty window → depth 0 by construction, no false alarm, and the
 * queue starts reporting real numbers the moment the subscription goes live
 * without anyone flipping anything.
 *
 * `oldestOpenAgeHours` is meaningful here: a bounced verification email is a
 * person who cannot finish signing up, and the age is how long they have been
 * stuck.
 */
export async function undeliveredAuthEmailFlow(db: Db, now: Date): Promise<QueueDrainRow> {
  const d = (days: number) => new Date(now.getTime() - days * DAY_MS);

  const [firstEvent] = await db
    .select({ t: sql<number | null>`min(${emailDeliveryEvents.receivedAt})` })
    .from(emailDeliveryEvents);
  const since = firstEvent?.t != null ? new Date(Number(firstEvent.t) * 1000) : null;

  // No delivery events have ever arrived — the subscription does not exist yet
  // (or has never fired). Report an honest empty queue rather than an alarm.
  if (!since) {
    return {
      queueName: "undelivered_auth_email",
      label: "Auth email that did not arrive",
      href: QUEUE_DRAIN_HREF,
      depth: 0,
      inflow7d: 0,
      outflow7d: null,
      inflow14d: 0,
      outflow14d: null,
      oldestOpenAgeHours: null,
      inflow1d: 0,
      outflow1d: null,
      drainRatio7d: null,
    };
  }

  const undelivered = and(
    gte(emailSendLedger.sentAt, since),
    like(emailSendLedger.source, "auth.%"),
    inArray(emailSendLedger.deliveryStatus, ["bounced", "rejected", "failed"])
  );
  const [depth, inflow1d, inflow7d, inflow14d, oldest] = await Promise.all([
    cnt(db, emailSendLedger, undelivered),
    cnt(db, emailSendLedger, and(undelivered, gte(emailSendLedger.sentAt, d(1)))),
    cnt(db, emailSendLedger, and(undelivered, gte(emailSendLedger.sentAt, d(7)))),
    cnt(db, emailSendLedger, and(undelivered, gte(emailSendLedger.sentAt, d(14)))),
    db
      .select({ oldest: sql<number | null>`min(${emailSendLedger.sentAt})` })
      .from(emailSendLedger)
      .where(undelivered),
  ]);

  const oldestSec = oldest[0]?.oldest ?? null;
  return {
    queueName: "undelivered_auth_email",
    label: "Auth email that did not arrive",
    href: QUEUE_DRAIN_HREF,
    depth,
    inflow7d,
    // Nothing "drains" these today: the operator affordance (resend / mark
    // verified) is scope 4 of OPE-177 and is not built. Reporting a computed
    // outflow would imply a workflow that does not exist.
    outflow7d: null,
    inflow14d,
    outflow14d: null,
    oldestOpenAgeHours:
      oldestSec != null ? (now.getTime() / 1000 - Number(oldestSec)) / 3600 : null,
    inflow1d,
    outflow1d: null,
    drainRatio7d: null,
  };
}

/**
 * OPE-177 — verification mail that DID arrive and was never acted on.
 *
 * This queue exists because the delivery-event feed falsified the premise that
 * created the ticket. OPE-177 was filed as a deliverability problem: a vendor
 * registered, asked for the confirmation email three times, got none. The first
 * week of real events says that is the rare case, not the common one —
 * `auth.register` measured 14 delivered against 1 bounced, and four of the five
 * most recent unverified registrations had their mail confirmed delivered.
 *
 * So `undelivered_auth_email` above, which counts only mail that provably did
 * not arrive, reads 1 while roughly nineteen people are stuck. It is correct and
 * it is not the number anyone should be managing to. Scope 3 of the ticket asked
 * for a signal on verification mail going "unconfirmed at an elevated rate", and
 * this is that half. It was unbuildable before the subscription existed: without
 * delivery events there is no way to separate "never arrived" from "arrived and
 * was ignored", and a single combined count of unverified users conflates a
 * deliverability incident with ordinary human drop-off.
 *
 * ── Definitions, because the three windows deliberately differ ──────────────
 * depth    — unverified registrations whose auth mail was DELIVERED more than
 *            `GRACE_H` ago. The grace matters: someone who signed up nine
 *            minutes ago has not failed to confirm, and without it every fresh
 *            signup would flag and the operator would learn to ignore the tile.
 * inflow   — distinct registrations that received delivered auth mail in the
 *            window. No grace: this is arrivals into the population, not stuck.
 * outflow  — distinct registrations that VERIFIED in the window and had
 *            delivered auth mail. That makes `drainRatio7d` the confirmation
 *            rate of delivered verification mail, which is the actual quantity
 *            scope 3 named.
 *
 * The window is self-gating in the same way as the queue above — it starts at
 * the first delivery event we ever received, so before the subscription fired
 * this reports an honest zero rather than indicting every historical NULL.
 *
 * Recipient matching is case-insensitive: `users.email` preserves the casing a
 * person typed (`Leavienessa@gmail.com` is a live row) while the ledger records
 * what was passed to the mailer. An exact-equality join would silently
 * undercount, and a signal that quietly reads low is worse than no signal.
 */
export async function unconfirmedAuthEmailFlow(
  db: Db,
  now: Date,
  /**
   * OPE-637 — hours a delivered verification email is given before it counts
   * as stuck. Supplied by the caller from `tunable_thresholds`.
   *
   * This was `const GRACE_H = 24`, which was the exact thing John's 2026-08-14
   * constraint 1 ruled out ("No magic 24/48 baked into code") and half the
   * specified 48h seed. The window decides who appears in the queue, so it was
   * a live operator threshold that could not be changed without a deploy.
   *
   * The default is the fail-open path only — see verification-threshold.ts.
   */
  graceHours: number = DEFAULT_VERIFICATION_GRACE_HOURS
): Promise<QueueDrainRow> {
  const GRACE_H = graceHours;
  const d = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const graceCutoff = new Date(now.getTime() - GRACE_H * 60 * 60 * 1000);

  const empty = (): QueueDrainRow => ({
    queueName: "unconfirmed_auth_email",
    label: "Auth email delivered but never confirmed",
    href: QUEUE_DRAIN_HREF,
    depth: 0,
    inflow7d: 0,
    outflow7d: null,
    inflow14d: 0,
    outflow14d: null,
    oldestOpenAgeHours: null,
    inflow1d: 0,
    outflow1d: null,
    drainRatio7d: null,
  });

  const [firstEvent] = await db
    .select({ t: sql<number | null>`min(${emailDeliveryEvents.receivedAt})` })
    .from(emailDeliveryEvents);
  if (firstEvent?.t == null) return empty();
  const since = new Date(Number(firstEvent.t) * 1000);

  const sameRecipient = sql`lower(${emailSendLedger.recipient}) = lower(${users.email})`;
  const deliveredAuthSend = and(
    like(emailSendLedger.source, "auth.%"),
    eq(emailSendLedger.deliveryStatus, "delivered"),
    gte(emailSendLedger.sentAt, since)
  );
  // Placeholder OWNER accounts (OPE-292) are not registrations and never verify.
  const realRegistration = eq(users.origin, "registration");

  const distinctUsers = async (where: SQL | undefined): Promise<number> => {
    const [r] = await db
      .select({ n: sql<number>`count(distinct ${users.id})` })
      .from(users)
      .innerJoin(emailSendLedger, sameRecipient)
      .where(where);
    return Number(r?.n ?? 0);
  };

  const stuck = and(
    realRegistration,
    isNull(users.emailVerified),
    deliveredAuthSend,
    lt(emailSendLedger.sentAt, graceCutoff)
  );
  const arrived = (from: Date) =>
    and(realRegistration, deliveredAuthSend, gte(emailSendLedger.sentAt, from));
  const confirmed = (from: Date) =>
    and(
      realRegistration,
      deliveredAuthSend,
      isNotNull(users.emailVerified),
      gte(users.emailVerified, from)
    );

  const [depth, inflow1d, inflow7d, inflow14d, outflow1d, outflow7d, outflow14d, oldest] =
    await Promise.all([
      distinctUsers(stuck),
      distinctUsers(arrived(d(1))),
      distinctUsers(arrived(d(7))),
      distinctUsers(arrived(d(14))),
      distinctUsers(confirmed(d(1))),
      distinctUsers(confirmed(d(7))),
      distinctUsers(confirmed(d(14))),
      db
        .select({ oldest: sql<number | null>`min(${emailSendLedger.sentAt})` })
        .from(users)
        .innerJoin(emailSendLedger, sameRecipient)
        .where(stuck),
    ]);

  const oldestSec = oldest[0]?.oldest ?? null;
  return {
    queueName: "unconfirmed_auth_email",
    label: "Auth email delivered but never confirmed",
    href: QUEUE_DRAIN_HREF,
    depth,
    inflow7d,
    outflow7d,
    inflow14d,
    outflow14d,
    oldestOpenAgeHours:
      oldestSec != null ? (now.getTime() / 1000 - Number(oldestSec)) / 3600 : null,
    inflow1d,
    outflow1d,
    drainRatio7d: ratio(outflow7d, inflow7d),
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
/**
 * OPE-497 scope 3 — the ENTITY-level promoter enrichment queue.
 *
 * `promoter_enrichment` (already monitored) counts rows in
 * `promoter_enrichment_candidates` — the REVIEW queue, depth ~848. The queue the
 * drain task actually selects from is
 * `promoters.enrichment_status = 'NEEDS_ENRICHMENT'` — depth 485 — and it was
 * absent from `queue_drain_snapshots` entirely. Two different queues, one of
 * them invisible, with names close enough that the dashboard read as covering
 * both.
 *
 * Flows are reported NULL, deliberately. Becoming NEEDS_ENRICHMENT is a status
 * transition, not a row creation, and the column that would date the exit —
 * `promoters.last_enriched_at` — is 91% NULL including 51 of the 56 ENRICHED
 * rows (OPE-496). So outflow genuinely is not computable here yet.
 *
 * `assessQueueFreeze` returns null for a null outflow, so this row publishes
 * DEPTH without ever raising a RED it cannot justify. When OPE-496 makes
 * `last_enriched_at` reliable, wiring the flows in is a small follow-up and the
 * alerting starts working on its own. Silence beats a false alarm; an invisible
 * 485-deep queue beats neither.
 */
export async function promoterNeedsEnrichmentFlow(db: Db): Promise<QueueDrainRow> {
  const [row] = await db
    .select({ n: count() })
    .from(promoters)
    .where(eq(promoters.enrichmentStatus, "NEEDS_ENRICHMENT"));

  return {
    queueName: "promoter_needs_enrichment",
    label: "Promoters awaiting enrichment (entity queue)",
    href: QUEUE_DRAIN_HREF,
    depth: row?.n ?? 0,
    inflow7d: 0,
    outflow7d: null,
    inflow14d: 0,
    outflow14d: null,
    oldestOpenAgeHours: null,
    inflow1d: 0,
    outflow1d: null,
    drainRatio7d: null,
  };
}

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
    inboundHeldSubmissionFlow(db, now),
    promoterNeedsEnrichmentFlow(db),
    enrichment(
      "promoter_enrichment",
      "Promoter enrichment review",
      promoterEnrichmentCandidates,
      promoterEnrichmentCandidates.createdAt,
      promoterEnrichmentCandidates.reviewedAt,
      promoterEnrichmentCandidates.decision
    ),
    // OPE-375 — the zero here is BY DESIGN, and the label has to say so.
    //
    // Its two neighbours are fed by scheduled selectors (select-candidates.ts,
    // promoter-select.ts) and a queue each; performer enrichment has NEITHER —
    // no selector, no `performer-enrichment` queue, and `performer-dispatch.ts`
    // is reachable only through the manual `enrich_performer` MCP tool. The
    // table has held 0 candidates in any state, ever, against 249 performers.
    //
    // So a bare "0" sitting beside vendor's +28/day read as "drained and
    // healthy" when it actually meant "nothing has ever produced into this".
    // That ambiguity IS the defect — an absence reported as health. The label
    // now carries the distinction the number cannot.
    enrichment(
      "performer_enrichment",
      "Performer enrichment review (manual only — no scheduled producer)",
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
    // OPE-413 — the only queue in this list with members of the public waiting
    // on the other end. Reached 138 days unwatched.
    pendingSubmissionsFlow(db, now),
    // OPE-177 — verification mail that provably did not arrive. Reads 0 until
    // the CF Email Sending subscription publishes its first event (the window
    // starts there), so it cannot cry wolf on historical NULLs.
    undeliveredAuthEmailFlow(db, now),
    // OPE-177 — the other half, and the bigger one. Once delivery events made
    // "did not arrive" measurable, the first week's data said it is NOT the
    // dominant cause of a stuck signup: 14 delivered vs 1 bounced on
    // auth.register. Counting only undelivered mail would have reported 1 while
    // ~19 people sat unverified.
    unconfirmedAuthEmailFlow(db, now, await loadVerificationGraceHours(db)),
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
