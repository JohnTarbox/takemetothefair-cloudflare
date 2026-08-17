/**
 * OPE-413 — the PENDING submissions queue, split into the three states that
 * need different responses.
 *
 * The queue reached 138 days with nobody watching. Its rows are not
 * interchangeable, and lumping them into one "backlog: N" is what made the
 * number ignorable:
 *
 *   WAITING   past the review promise, a real person's address attached.
 *             Someone is refreshing their inbox. This is the urgent class.
 *   ROUTINE   past the promise, no submitter address (bot/discovery rows).
 *             Worth draining, nobody is waiting.
 *   IMMINENT  the EVENT starts within days. Urgent regardless of queue age,
 *             because approving it late is the same as not approving it.
 *   EXPIRED   the event's start date has already passed. Cannot be approved
 *             as-is at all — it needs a decision (reject, or roll to next
 *             year's edition), not a place further down the same list.
 *
 * EXPIRED is the category the ticket was really about: several submissions sat
 * in this queue until the fair they described had already happened. A backlog
 * list that mixes those in with things still worth approving hides the only
 * rows where waiting has already cost something irreversible.
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { events, tunableThresholds } from "@/lib/db/schema";

type Db = DrizzleD1Database<typeof schema>;

/** Threshold key in `tunable_thresholds`. Shared with the MCP-side Monday
 *  digest, which reads the same row from the same D1. */
export const PENDING_SLA_KEY = "pending_submission_sla_hours";

/** Used only when the row is missing (fresh DB, failed migration). Matches the
 *  promise printed on /suggest-event so the fallback cannot be quietly softer
 *  than the commitment. */
export const PENDING_SLA_FALLBACK_HOURS = 48;

/** How close an event start has to be for the submission to be urgent whatever
 *  its queue age. A week is roughly the last moment approving it still helps
 *  somebody plan to attend. */
export const IMMINENT_DAYS = 7;

export interface PendingRow {
  id: string;
  name: string;
  slug: string;
  createdAt: Date | null;
  startDate: Date | null;
  suggesterEmail: string | null;
  ageHours: number;
}

export interface PendingSlaReport {
  thresholdHours: number;
  /** Past the promise WITH someone waiting. Oldest first. */
  waiting: PendingRow[];
  /** Past the promise, nobody waiting. Oldest first. */
  routine: PendingRow[];
  /** Event starts within IMMINENT_DAYS, any queue age. Soonest first. */
  imminent: PendingRow[];
  /** Event already started/passed — needs disposition, not approval. */
  expired: PendingRow[];
  /** Total PENDING, so the tiers can be read against the whole. */
  totalPending: number;
}

/** Read the operator-tunable SLA, falling back to the published promise. */
export async function readPendingSlaHours(db: Db): Promise<number> {
  try {
    const [row] = await db
      .select({ value: tunableThresholds.value })
      .from(tunableThresholds)
      .where(eq(tunableThresholds.key, PENDING_SLA_KEY))
      .limit(1);
    const v = row?.value;
    // A zero or negative threshold would classify everything as breaching and
    // is far more likely to be a typo than an intention.
    return typeof v === "number" && v > 0 ? v : PENDING_SLA_FALLBACK_HOURS;
  } catch {
    return PENDING_SLA_FALLBACK_HOURS;
  }
}

function toRow(
  r: {
    id: string;
    name: string;
    slug: string;
    createdAt: Date | null;
    startDate: Date | null;
    suggesterEmail: string | null;
  },
  now: Date
): PendingRow {
  const ageHours = r.createdAt ? (now.getTime() - r.createdAt.getTime()) / 3_600_000 : 0;
  return { ...r, ageHours };
}

/**
 * Classify the whole PENDING queue in one read.
 *
 * One query, sorted oldest-first, then partitioned in memory: the queue is
 * dozens of rows, not thousands, and four separate round-trips would let the
 * tiers disagree with each other if a row changed between them.
 */
export async function getPendingSlaReport(
  db: Db,
  now: Date = new Date()
): Promise<PendingSlaReport> {
  const thresholdHours = await readPendingSlaHours(db);
  const breachCutoff = new Date(now.getTime() - thresholdHours * 3_600_000);
  const imminentCutoff = new Date(now.getTime() + IMMINENT_DAYS * 86_400_000);
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const rows = (
    await db
      .select({
        id: events.id,
        name: events.name,
        slug: events.slug,
        createdAt: events.createdAt,
        startDate: events.startDate,
        suggesterEmail: events.suggesterEmail,
      })
      .from(events)
      .where(and(eq(events.status, "PENDING"), isNull(events.mergedInto)))
      .orderBy(asc(events.createdAt))
  ).map((r) => toRow(r, now));

  const expired = rows.filter((r) => r.startDate !== null && r.startDate < todayStart);
  const live = rows.filter((r) => !expired.includes(r));

  const breaching = live.filter((r) => r.createdAt !== null && r.createdAt < breachCutoff);
  const hasSubmitter = (r: PendingRow) => !!r.suggesterEmail && r.suggesterEmail.trim() !== "";

  const imminent = live
    .filter((r) => r.startDate !== null && r.startDate <= imminentCutoff)
    .sort((a, b) => (a.startDate!.getTime() ?? 0) - (b.startDate!.getTime() ?? 0));

  return {
    thresholdHours,
    waiting: breaching.filter(hasSubmitter),
    routine: breaching.filter((r) => !hasSubmitter(r)),
    imminent,
    expired,
    totalPending: rows.length,
  };
}

/**
 * One-line summary for a digest. Returns null when there is genuinely nothing
 * to report, so a quiet week produces no block rather than a row of zeros
 * nobody reads past.
 */
export function summarizePendingSla(report: PendingSlaReport): string | null {
  const parts: string[] = [];
  if (report.waiting.length > 0) parts.push(`${report.waiting.length} with someone waiting`);
  if (report.expired.length > 0) parts.push(`${report.expired.length} already past their date`);
  if (report.imminent.length > 0) parts.push(`${report.imminent.length} starting within a week`);
  if (report.routine.length > 0) parts.push(`${report.routine.length} routine`);
  if (parts.length === 0) return null;
  return `${report.totalPending} PENDING — ${parts.join(", ")}`;
}
