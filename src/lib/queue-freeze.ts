/**
 * OPE-247 — "a work queue is frozen / draining too slowly" detector.
 *
 * The failure this exists for: the event-discrepancy queue grew 4,774 → 5,890
 * over 14 days with ONE lifetime resolution — a six-week freeze no dashboard
 * surfaced, because every existing tile measures detection (inflow), not
 * drainage (outflow). Same blindness on vendor enrichment (3,039 pending vs 304
 * decided) and site-health (resolve/snooze never used).
 *
 * This module is the pure, testable decision: given each queue's depth + inflow
 * + outflow over trailing windows, return the ones a human has stopped draining
 * — shaped as StaleRed so they merge into the SAME OPE-75 operator digest that
 * already reaches John (see src/app/api/internal/cpi/stale-red-scan). No new
 * alerter, no new cron — mirrors OPE-243's integration-silence exactly.
 *
 * Two red conditions (per the ticket):
 *   - FROZEN: depth > 0 AND zero outflow across the last N days (default 7).
 *   - SLOW DRAIN: draining < THRESHOLD of the inflow rate across 14 days.
 * A queue whose outflow can't yet be computed (the inbound exception queue
 * before it has snapshot history) returns null — silence beats a false alarm.
 */
import type { StaleRed } from "@/lib/cpi/stale-reds";

/** Days of zero outflow (with a non-empty queue) before FROZEN fires. */
export const FROZEN_ZERO_OUTFLOW_DAYS = 7;
/** Trailing-14d outflow÷inflow below which SLOW-DRAIN fires. */
export const SLOW_DRAIN_RATIO_THRESHOLD = 0.5;

const MS_PER_HOUR = 3_600_000;

export interface QueueFlow {
  /** Stable key, e.g. "event_discrepancies". */
  queueName: string;
  /** Human display, e.g. "Event discrepancies". */
  label: string;
  /** Dashboard deep-link (the tile anchor) for the digest. */
  href: string;
  /** Current open/pending backlog. */
  depth: number;
  inflow7d: number;
  /** Rows decided/closed in the trailing 7d. null = not computable (skip). */
  outflow7d: number | null;
  inflow14d: number;
  outflow14d: number | null;
  /**
   * Age of the oldest still-open item, in hours — a proxy for how long the
   * backlog has been stuck, used as the digest's `hoursInRed`. null → fall back
   * to the freeze window so the digest can still say roughly how long.
   */
  oldestOpenAgeHours: number | null;
}

function toRed(priority: "P0" | "P1", title: string, flow: QueueFlow, now: Date): StaleRed {
  const hours = flow.oldestOpenAgeHours ?? FROZEN_ZERO_OUTFLOW_DAYS * 24;
  return {
    priority,
    title,
    refKey: `queue-freeze:${flow.queueName}`,
    href: flow.href,
    firstDetectedAt: new Date(now.getTime() - hours * MS_PER_HOUR).toISOString(),
    hoursInRed: hours,
  };
}

/**
 * Decide whether one queue is a drain RED. Returns null when the queue is
 * empty, when its outflow is unknown, or when it's draining acceptably. Never
 * throws. P1 (a backlog to fix, not a 3am page) — the digest re-lists it every
 * day it persists, which is the whole point vs the silent six-week freeze.
 */
export function assessQueueFreeze(flow: QueueFlow, now: Date): StaleRed | null {
  if (flow.depth <= 0) return null; // an empty queue can't be frozen
  if (flow.outflow7d === null) return null; // outflow not yet computable → don't cry wolf

  // FROZEN — a real backlog with zero drainage in the last week.
  if (flow.outflow7d === 0) {
    return toRed(
      "P1",
      `${flow.label}: ${flow.depth} open, 0 closed in ${FROZEN_ZERO_OUTFLOW_DAYS}d (frozen)`,
      flow,
      now
    );
  }

  // SLOW DRAIN — over 14d, closing less than half of what's arriving.
  if (flow.outflow14d !== null && flow.inflow14d > 0) {
    const ratio = flow.outflow14d / flow.inflow14d;
    if (ratio < SLOW_DRAIN_RATIO_THRESHOLD) {
      return toRed(
        "P1",
        `${flow.label}: drain ratio ${ratio.toFixed(2)} over 14d ` +
          `(< ${SLOW_DRAIN_RATIO_THRESHOLD}); ${flow.depth} open, ${flow.inflow14d} in / ${flow.outflow14d} out`,
        flow,
        now
      );
    }
  }

  return null;
}

/** Assess every queue; returns the drain REDs (healthy ones drop out). */
export function assessAllQueueFreeze(flows: QueueFlow[], now: Date): StaleRed[] {
  const out: StaleRed[] = [];
  for (const f of flows) {
    const red = assessQueueFreeze(f, now);
    if (red) out.push(red);
  }
  return out;
}
