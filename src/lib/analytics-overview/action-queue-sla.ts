/**
 * OPE-78 — CPI Move 4: age the Action Queue.
 *
 * Derives per-item age-in-red + an SLA state, and provides the default
 * ordering that surfaces the oldest-ignored breaches first. The SLA `red`
 * boundary reuses the Move-1 (OPE-75) thresholds, so a `red` chip is exactly
 * the point at which the stale-red alert fires — the dashboard and the alert
 * agree on "breached" by construction.
 */
import type { ActionQueueEntry, ActionQueueSla } from "./types";
import { STALE_THRESHOLD_HOURS } from "@/lib/cpi/stale-reds";

const MS_PER_HOUR = 3_600_000;

/**
 * Compute `hoursInRed` + `slaStatus` for an entry from its first-detected
 * stamp. A null/unparseable stamp → `{ null, "none" }` (a rule-rule entry has
 * no age). `red` = breached the priority threshold (Move-1 alert point);
 * `amber` = past half the threshold (approaching); `green` = within window.
 */
export function actionQueueSla(
  priority: "P0" | "P1",
  firstDetectedAt: string | null,
  now: Date
): { hoursInRed: number | null; slaStatus: ActionQueueSla } {
  if (!firstDetectedAt) return { hoursInRed: null, slaStatus: "none" };
  const firstMs = new Date(firstDetectedAt).getTime();
  if (Number.isNaN(firstMs)) return { hoursInRed: null, slaStatus: "none" };

  const hoursInRed = (now.getTime() - firstMs) / MS_PER_HOUR;
  const breach = STALE_THRESHOLD_HOURS[priority]; // P0: 24h, P1: 72h
  let slaStatus: ActionQueueSla;
  if (hoursInRed > breach) slaStatus = "red";
  else if (hoursInRed > breach / 2) slaStatus = "amber";
  else slaStatus = "green";
  return { hoursInRed, slaStatus };
}

/**
 * Default action-queue ordering (OPE-78): oldest breach first — sort by
 * `hoursInRed` descending so the most-ignored reds surface at the top, with
 * severity (P0 before P1) as the tiebreaker, then a stable source/refKey tail.
 * Entries with no age (`hoursInRed === null`) sort last.
 *
 * NOTE (design choice, flagged for review): this is age-primary per the ticket
 * ("days_in_red desc, severity as tiebreaker"), so a long-ignored P1 can rank
 * above a freshly-detected P0. Flip the first two comparisons to make severity
 * primary if P0-always-first is preferred.
 */
export function compareActionQueueEntries(a: ActionQueueEntry, b: ActionQueueEntry): number {
  const ah = a.hoursInRed;
  const bh = b.hoursInRed;
  // Nulls (no age) sink to the bottom.
  if (ah === null && bh === null) {
    // both ageless → severity, then stable tail
    return tieBreak(a, b);
  }
  if (ah === null) return 1;
  if (bh === null) return -1;
  if (ah !== bh) return bh - ah; // oldest (largest hoursInRed) first
  return tieBreak(a, b);
}

function tieBreak(a: ActionQueueEntry, b: ActionQueueEntry): number {
  if (a.priority !== b.priority) return a.priority === "P0" ? -1 : 1;
  if (a.source !== b.source) return a.source === "kpi" ? -1 : 1;
  return a.refKey.localeCompare(b.refKey);
}
