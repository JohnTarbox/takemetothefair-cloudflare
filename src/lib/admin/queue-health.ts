/**
 * OPE-1603 — one row per work queue for the /admin dashboard: what is actionable
 * now, how old the oldest item is, and what moved in the last 7 days.
 *
 * Definitions match the Analytics "Queue drain ratios" tile where a queue appears
 * in both. It is not called directly because that tile computes ~15 queues at
 * 7+ counts each, too heavy for a page opened on every admin visit (OPE-1573).
 *
 * A failed read shows "—", never 0: an empty queue and an unread one must differ.
 */
import { and, count, eq, gte, isNull, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  entityClaims,
  eventDiscrepancies,
  events,
  inboundEmails,
  performerEnrichmentCandidates,
  problemReports,
  promoterEnrichmentCandidates,
  vendorEnrichmentCandidates,
} from "@/lib/db/schema";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "@/lib/db/schema";
import { buildCorrespondentBriefing } from "@/lib/correspondents/briefing";
import { DUPLICATE_FLAGS_PATH, loadDuplicateFlagFlow } from "@/lib/duplicates/flag-queue";
import { upcomingEndPredicate } from "@/lib/event-dates";
import { logError } from "@/lib/logger";

type Db = DrizzleD1Database<typeof schema>;

const WEEK_MS = 7 * 86_400_000;
/** No page drains these two yet, so the tile opens their drain-ratio row. */
const QUEUE_DRAIN_PATH = "/admin/analytics#queue-drain-ratios";

export type QueueTile = {
  key: string;
  label: string;
  href: string;
  /** null = the read failed. */
  actionable: number | null;
  oldestAgeHours: number | null;
  in7d: number | null;
  /** null = failed, or the queue stores no "handled at" time. */
  out7d: number | null;
};

type Counts = Pick<QueueTile, "actionable" | "in7d" | "out7d"> & { oldestSec: number | null };

async function countQueue(
  db: Db,
  table: SQLiteTable,
  spec: { open: SQL; ageCol: AnyColumn; inWhere: SQL; outWhere: SQL | null }
): Promise<Counts> {
  // Three narrow queries rather than one conditional aggregate, so `open` can
  // use its status index instead of reading every decided row.
  const [[open], [arrived], left] = await Promise.all([
    db
      .select({ n: count(), oldest: sql<number | null>`min(${spec.ageCol})` })
      .from(table)
      .where(spec.open),
    db.select({ n: count() }).from(table).where(spec.inWhere),
    spec.outWhere ? db.select({ n: count() }).from(table).where(spec.outWhere) : null,
  ]);
  return {
    actionable: open?.n ?? 0,
    oldestSec: open?.oldest == null ? null : Number(open.oldest),
    in7d: arrived?.n ?? 0,
    out7d: left ? (left[0]?.n ?? 0) : null,
  };
}

/** Upcoming, or undated: an undated submission still needs a decision. */
function upcomingPending(now: Date): SQL {
  return and(
    eq(events.status, "PENDING"),
    isNull(events.mergedInto),
    or(upcomingEndPredicate(now), sql`COALESCE(${events.endDate}, ${events.startDate}) IS NULL`)
  ) as SQL;
}

function sumCounts(parts: Counts[]): Counts {
  const oldest = parts.flatMap((p) => (p.oldestSec == null ? [] : [p.oldestSec]));
  return {
    actionable: parts.reduce((n, p) => n + (p.actionable ?? 0), 0),
    oldestSec: oldest.length ? Math.min(...oldest) : null,
    in7d: parts.reduce((n, p) => n + (p.in7d ?? 0), 0),
    out7d: parts.reduce((n, p) => n + (p.out7d ?? 0), 0),
  };
}

export async function loadQueueHealth(db: Db, now: Date = new Date()): Promise<QueueTile[]> {
  const since = new Date(now.getTime() - WEEK_MS);
  const enrichment = (
    table: SQLiteTable,
    createdAt: AnyColumn,
    reviewedAt: AnyColumn,
    decision: AnyColumn
  ) =>
    countQueue(db, table, {
      open: eq(decision, "pending"),
      ageCol: createdAt,
      inWhere: gte(createdAt, since),
      outWhere: gte(reviewedAt, since),
    });

  const queues: Array<{
    key: string;
    label: string;
    href: string;
    load: () => Promise<Counts>;
  }> = [
    {
      key: "submissions",
      label: "Submissions (upcoming)",
      href: "/admin/submissions",
      load: () => {
        const open = upcomingPending(now);
        return countQueue(db, events, {
          open,
          ageCol: events.createdAt,
          inWhere: and(open, gte(events.createdAt, since)) as SQL,
          // The same "left the queue" test as the drain tile.
          outWhere: and(
            sql`${events.status} != 'PENDING'`,
            gte(events.updatedAt, since),
            sql`${events.sourceName} IN ('community-suggestion','email-submission','vendor-submission')`
          ) as SQL,
        });
      },
    },
    {
      key: "claims",
      label: "Claims",
      href: "/admin/claims",
      load: () =>
        countQueue(db, entityClaims, {
          open: eq(entityClaims.status, "PENDING"),
          ageCol: entityClaims.createdAt,
          inWhere: gte(entityClaims.createdAt, since),
          outWhere: gte(entityClaims.decidedAt, since),
        }),
    },
    {
      key: "duplicates",
      label: "Duplicate flags",
      href: DUPLICATE_FLAGS_PATH,
      load: async () => {
        const f = await loadDuplicateFlagFlow(db, now);
        return {
          actionable: f.depth,
          oldestSec: f.oldestOpenAt ? Math.floor(f.oldestOpenAt.getTime() / 1000) : null,
          in7d: f.inflow7d,
          out7d: f.outflow7d,
        };
      },
    },
    {
      key: "inbound",
      label: "Inbound awaiting a human",
      href: "/admin/inbound-emails?status=awaiting_human",
      load: () => {
        const open = eq(inboundEmails.status, "awaiting_human");
        return countQueue(db, inboundEmails, {
          open,
          ageCol: inboundEmails.receivedAt,
          inWhere: and(open, gte(inboundEmails.receivedAt, since)) as SQL,
          outWhere: null, // inbound_emails has no handled-at column
        });
      },
    },
    {
      key: "problem-reports",
      label: "Problem reports",
      href: "/admin/problem-reports",
      load: () => {
        const defect = eq(problemReports.kind, "defect");
        return countQueue(db, problemReports, {
          open: and(defect, isNull(problemReports.resolvedAt)) as SQL,
          ageCol: problemReports.createdAt,
          inWhere: and(defect, gte(problemReports.createdAt, since)) as SQL,
          outWhere: and(defect, gte(problemReports.resolvedAt, since)) as SQL,
        });
      },
    },
    {
      key: "correspondents",
      label: "Correspondents waiting on us",
      href: "/admin/correspondents",
      load: async () => {
        // The page's own read, so the tile and the list it opens always agree.
        const { waiting } = await buildCorrespondentBriefing(db, { now });
        const oldest = waiting.map((r) => Math.floor(r.receivedAt.getTime() / 1000));
        return {
          actionable: waiting.length,
          oldestSec: oldest.length ? Math.min(...oldest) : null,
          in7d: null,
          out7d: null,
        };
      },
    },
    {
      key: "discrepancies",
      label: "Discrepancies",
      href: QUEUE_DRAIN_PATH,
      load: () =>
        countQueue(db, eventDiscrepancies, {
          open: eq(eventDiscrepancies.resolutionStatus, "open"),
          ageCol: eventDiscrepancies.detectedAt,
          inWhere: gte(eventDiscrepancies.detectedAt, since),
          outWhere: gte(eventDiscrepancies.resolvedAt, since),
        }),
    },
    {
      key: "enrichment",
      label: "Enrichment reviews",
      href: QUEUE_DRAIN_PATH,
      load: async () =>
        sumCounts(
          await Promise.all([
            enrichment(
              vendorEnrichmentCandidates,
              vendorEnrichmentCandidates.createdAt,
              vendorEnrichmentCandidates.reviewedAt,
              vendorEnrichmentCandidates.decision
            ),
            enrichment(
              promoterEnrichmentCandidates,
              promoterEnrichmentCandidates.createdAt,
              promoterEnrichmentCandidates.reviewedAt,
              promoterEnrichmentCandidates.decision
            ),
            enrichment(
              performerEnrichmentCandidates,
              performerEnrichmentCandidates.createdAt,
              performerEnrichmentCandidates.reviewedAt,
              performerEnrichmentCandidates.decision
            ),
          ])
        ),
    },
  ];

  return Promise.all(
    queues.map(async ({ key, label, href, load }): Promise<QueueTile> => {
      try {
        const { oldestSec, ...counts } = await load();
        return {
          key,
          label,
          href,
          ...counts,
          oldestAgeHours: oldestSec == null ? null : (now.getTime() / 1000 - oldestSec) / 3600,
        };
      } catch (error) {
        await logError(db, {
          message: `Queue health read failed: ${key}`,
          error,
          source: "lib/admin/queue-health.ts",
        });
        return {
          key,
          label,
          href,
          actionable: null,
          oldestAgeHours: null,
          in7d: null,
          out7d: null,
        };
      }
    })
  );
}

/** "3d" past two days, otherwise hours. */
export function formatQueueAge(hours: number | null): string {
  if (hours == null) return "—";
  if (hours >= 48) return `${Math.floor(hours / 24)}d`;
  return hours < 1 ? "<1h" : `${Math.floor(hours)}h`;
}
