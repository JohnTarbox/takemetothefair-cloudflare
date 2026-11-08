/**
 * OPE-1585 — send a recurring operator digest only when its contents changed.
 *
 * The rule the stale-red digest already follows (OPE-308), generalised:
 * a standing queue that has not moved is news once, and after that it belongs
 * in the Monday inventory. Mail that repeats unchanged state every morning is
 * how a channel stops being read.
 *
 * "Changed" is measured against what the LAST SENT digest said, never against
 * yesterday, so slow drift accumulates and is eventually reported instead of
 * being forgiven one day at a time.
 *
 * The comparison is on per-queue COUNTS. A swap inside one queue (one item
 * leaves, one enters, same count) reads as no change until the next count
 * move, and is covered by Monday's inventory.
 */
import { eq } from "drizzle-orm";
import { digestChangeState } from "@takemetothefair/db-schema";
import type { Db } from "./db.js";
import { logError } from "./logger.js";

export interface DigestSnapshot {
  /** Queue name → current size. */
  counts: Record<string, number>;
  /** Higher is worse: an alert tier, or an age bucket. A rise always sends. */
  severity: number;
}

/** Fraction of the last-sent total treated as ordinary churn. */
const DRIFT_RATIO = 0.1;

/**
 * How much movement is drift for a queue set of this size. Never below 1
 * (the ticket's ±1), and scaled so a 32-item queue doesn't mail on a +2 day.
 */
export function driftTolerance(lastTotal: number): number {
  return Math.max(1, Math.floor(lastTotal * DRIFT_RATIO));
}

/** Pure — exported for tests. True when this snapshot is worth a digest. */
export function digestChanged(current: DigestSnapshot, last: DigestSnapshot | null): boolean {
  if (last === null) return true;
  if (current.severity > last.severity) return true;

  let movement = 0;
  let lastTotal = 0;
  for (const key of new Set([...Object.keys(current.counts), ...Object.keys(last.counts)])) {
    const was = last.counts[key] ?? 0;
    const now = current.counts[key] ?? 0;
    // A queue that was empty and now has something in it is news at any size.
    if (was === 0 && now > 0) return true;
    movement += Math.abs(now - was);
    lastTotal += was;
  }
  return movement > driftTolerance(lastTotal);
}

/**
 * Should this digest send? Fails OPEN: a duplicate operator email is a
 * nuisance, and a suppressed one is the defect OPE-599 exists about.
 */
export async function shouldSendDigest(
  db: Db,
  key: string,
  current: DigestSnapshot,
  source: string
): Promise<boolean> {
  try {
    const [row] = await db
      .select()
      .from(digestChangeState)
      .where(eq(digestChangeState.key, key))
      .limit(1);
    if (!row) return true;
    return digestChanged(current, {
      counts: JSON.parse(row.countsJson) as Record<string, number>,
      severity: row.severity,
    });
  } catch (error) {
    await logError(db, {
      level: "warn",
      source,
      message: `[digest-change-gate] state read failed for ${key}; sending anyway`,
      error,
    });
    return true;
  }
}

/** Record what was just sent. Failsoft: the worst case is one repeat digest. */
export async function recordDigestSent(
  db: Db,
  key: string,
  current: DigestSnapshot,
  now: Date,
  source: string
): Promise<void> {
  const values = {
    countsJson: JSON.stringify(current.counts),
    severity: current.severity,
    lastSentAt: now,
  };
  try {
    await db
      .insert(digestChangeState)
      .values({ key, ...values })
      .onConflictDoUpdate({ target: digestChangeState.key, set: values });
  } catch (error) {
    await logError(db, {
      level: "warn",
      source,
      message: `[digest-change-gate] state write failed for ${key}`,
      error,
    });
  }
}

/** A queue that emptied starts over, so its next item is news. Failsoft. */
export async function clearDigestState(db: Db, key: string, source: string): Promise<void> {
  try {
    await db.delete(digestChangeState).where(eq(digestChangeState.key, key));
  } catch (error) {
    await logError(db, {
      level: "warn",
      source,
      message: `[digest-change-gate] state clear failed for ${key}`,
      error,
    });
  }
}
