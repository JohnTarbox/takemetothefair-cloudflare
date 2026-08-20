/**
 * OPE-497 scope 5 — read the queue-freeze gates from `tunable_thresholds`.
 *
 * The FROZEN and SLOW-DRAIN gates governed a live operator alert while existing
 * only as constants in `queue-freeze.ts`. An operator — or an investigating
 * agent — inspecting the database could see the queue depths, the snapshots and
 * the alert count, but not what the alert was actually testing. That opacity is
 * part of why OPE-497 was filed against a detector that was working.
 *
 * Deliberately fail-open to the code defaults. A missing or malformed row must
 * degrade to today's behaviour, never to "no thresholds, so no alerting" — an
 * unreadable config should not be able to silence a detector.
 */
import { inArray } from "drizzle-orm";
import { tunableThresholds } from "@/lib/db/schema";
import type { QueueFreezeThresholds } from "@/lib/queue-freeze";
import type { Db } from "@/lib/analytics-overview/shared";

export const FROZEN_DAYS_KEY = "queue_frozen_zero_outflow_days";
export const SLOW_DRAIN_RATIO_KEY = "queue_slow_drain_ratio";

/** A threshold is only honoured when it is a finite, positive number. */
function usable(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export async function loadQueueFreezeThresholds(db: Db): Promise<QueueFreezeThresholds> {
  try {
    const rows = await db
      .select({ key: tunableThresholds.key, value: tunableThresholds.value })
      .from(tunableThresholds)
      .where(inArray(tunableThresholds.key, [FROZEN_DAYS_KEY, SLOW_DRAIN_RATIO_KEY]));

    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    return {
      frozenZeroOutflowDays: usable(byKey.get(FROZEN_DAYS_KEY)),
      slowDrainRatio: usable(byKey.get(SLOW_DRAIN_RATIO_KEY)),
    };
  } catch {
    // Unreadable config → code defaults. Never silence the detector.
    return {};
  }
}
