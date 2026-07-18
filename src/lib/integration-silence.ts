/**
 * OPE-243 — generalized "an outbound integration has gone silent" detector.
 *
 * The failure this exists for: IndexNow submitted 0 URLs to Bing for 20 days
 * and nothing escalated to a human. A daily `warn` log DID fire the whole time,
 * but it was buried in error_logs, worded "this is expected… not a new failure",
 * and its email didn't reach anyone. Detection existed; escalation didn't. The
 * only reason it surfaced was John running a manual audit.
 *
 * This module is the pure, testable decision: given each outbound integration's
 * last-success time and whether it *should* be active right now (quota unspent
 * and/or work queued), return the ones that have been silent past a threshold —
 * shaped as StaleRed so they merge into the SAME OPE-75 operator digest that
 * already reaches John (see src/app/api/internal/cpi/stale-red-scan). No new
 * alerter, no new cron — the silence rides the escalation path that works.
 *
 * The core insight (deferral != success): "0 successes in 24h" for a job that
 * normally submits N/day is a RED, not a green. `deferred`/`skipped`/`paused`
 * outcomes must never be counted as success — an integration whose only recent
 * rows are `skipped` is silent, however tidy those rows look.
 */
import type { StaleRed } from "@/lib/cpi/stale-reds";

/** Default hours an integration may be silent-while-should-be-active before RED. */
export const INTEGRATION_SILENCE_THRESHOLD_HOURS = 24;

const MS_PER_HOUR = 3_600_000;

export interface IntegrationActivity {
  /** Display name, e.g. "IndexNow (Bing)". */
  name: string;
  /** Stable de-dup key for the digest, e.g. "integration-silence:indexnow". */
  refKey: string;
  /** Dashboard link an operator can open. */
  href: string;
  /**
   * Most recent SUCCESSFUL submission/send — NOT the most recent attempt.
   * A `skipped`/`deferred`/`failed` row is not a success (deferral != success).
   * Null = no success on record in the lookback window.
   */
  lastSuccessAt: Date | null;
  /**
   * Fallback "silent since" when `lastSuccessAt` is null (e.g. the pause start,
   * or the oldest piece of queued work) so the digest can still say how long.
   */
  silentSinceAt: Date | null;
  /**
   * True when the integration SHOULD be doing something right now — quota
   * unspent AND/OR work queued. When false, silence is EXPECTED (nothing to
   * send) and must stay quiet, or the probe becomes noise the day traffic is
   * legitimately zero.
   */
  shouldBeActive: boolean;
  /** One line for the digest on *why* it should be active (quota/queue facts). */
  activeReason: string;
  /** Optional per-integration override of the silence threshold. */
  thresholdHours?: number;
}

/**
 * Decide whether one integration is a silence RED. Returns null when healthy,
 * legitimately idle (`shouldBeActive === false`), or silent for less than the
 * threshold. Never throws.
 */
export function assessIntegrationSilence(a: IntegrationActivity, now: Date): StaleRed | null {
  if (!a.shouldBeActive) return null; // nothing to send → silence is fine

  const anchor = a.lastSuccessAt ?? a.silentSinceAt;
  // No success AND no known "silent since" — we can't age it, so don't cry wolf.
  if (!anchor) return null;

  const hoursSilent = (now.getTime() - anchor.getTime()) / MS_PER_HOUR;
  const threshold = a.thresholdHours ?? INTEGRATION_SILENCE_THRESHOLD_HOURS;
  if (hoursSilent <= threshold) return null; // recent enough → healthy

  const neverSucceeded = a.lastSuccessAt === null;
  const title =
    `${a.name}: 0 successful submissions in ~${Math.floor(hoursSilent / 24)}d ` +
    `while ${a.activeReason}` +
    (neverSucceeded ? " (no success on record)" : "");

  return {
    // P1: a degradation we want fixed but not paged on at 3am. The digest lists
    // it every day it persists (the whole point vs the 20-day silent stretch).
    priority: "P1",
    title,
    refKey: a.refKey,
    href: a.href,
    firstDetectedAt: anchor.toISOString(),
    hoursInRed: hoursSilent,
  };
}

/** Assess a table of integrations; returns the silence REDs (healthy ones drop out). */
export function assessAllIntegrationSilence(
  integrations: IntegrationActivity[],
  now: Date
): StaleRed[] {
  const out: StaleRed[] = [];
  for (const i of integrations) {
    const red = assessIntegrationSilence(i, now);
    if (red) out.push(red);
  }
  return out;
}
