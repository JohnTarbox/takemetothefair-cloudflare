/**
 * OPE-309 (assurance audit A5) — Bing Webmaster API liveness.
 *
 * The audit asked for "the GA4 liveness pattern, cloned for Bing": one daily
 * ping, a consecutive-failure counter, escalation when it stays unhealthy.
 * This is that shape, with two deliberate departures — both of which exist
 * because the original was measured before it was copied.
 *
 * ── Departure 1: the age anchor is the END of the data day, not the start ──
 *
 * `ga4_liveness_log` holds 97 rows spanning 2026-05-06 → 2026-08-12 and EVERY
 * ONE of them is `degraded`, with `data_age_seconds` equal to 30.0h on every
 * single row. It has never once been green.
 *
 * GA4 is healthy. The check is not. It runs at 06:00Z, GA4's freshest complete
 * day is "yesterday", and `computeAgeSeconds` anchors at *midnight of that
 * date* — so the smallest age the check can ever observe is 30h, measured
 * against a 24h `degraded` threshold. Green is unreachable by construction,
 * and the alarm has consequently fired 96 times without ever describing a
 * real defect.
 *
 * A row dated D reports on the whole of day D, so it is not late until day D
 * has ENDED. Anchoring at `D + 24h` makes the same thresholds mean what they
 * were always intended to mean:
 *
 *   | situation (checked 06:00Z)     | data date | age  | status   |
 *   |--------------------------------|-----------|------|----------|
 *   | healthy — yesterday's row      | D-1       |   6h | green    |
 *   | one day missing                | D-2       |  30h | degraded |
 *   | two days missing               | D-3       |  54h | critical |
 *
 * Measured against real Bing data before choosing: `GetCrawlStats` returned an
 * unbroken daily series 2026-04-30 → 2026-08-11 with no gaps, newest row
 * always the previous day. So "yesterday" is the healthy steady state and a
 * two-day hole is a genuine signal.
 *
 * ── Departure 2: unreachable is not the same as stale ──
 *
 * GA4's check collapses "the API threw" into the same null-date path as "the
 * data is old". They are different failures with different owners — a dead
 * credential is ours, a stale feed is Bing's — so `reachable` is carried
 * separately and an unreachable API is critical immediately rather than by
 * aging into it.
 *
 * This module is deliberately pure (no D1, no fetch) so every threshold above
 * is asserted in tests rather than trusted.
 */

/** A crawl-stats row dated D is not late until day D has ended. */
const MS_PER_HOUR = 3_600_000;
const DAY_MS = 24 * MS_PER_HOUR;

/** Data older than this (past the end of its day) is degraded. */
export const BING_DEGRADED_AFTER_HOURS = 24;
/** Data older than this (past the end of its day) is critical. */
export const BING_CRITICAL_AFTER_HOURS = 48;
/** Consecutive non-green checks before the run escalates. Mirrors GA4's 2. */
export const BING_ALERT_AFTER_CONSECUTIVE = 2;

export type BingLivenessStatus = "green" | "degraded" | "critical";

export interface BingLivenessInput {
  /** Newest `GetCrawlStats` date as YYYY-MM-DD, or null when none was returned. */
  maxDataDate: string | null;
  /** False when the Bing API threw (auth, timeout, 5xx, bad envelope). */
  reachable: boolean;
  now: Date;
}

export interface BingLivenessVerdict {
  status: BingLivenessStatus;
  /** Seconds past the END of the newest data day; null when unknown. */
  dataAgeSeconds: number | null;
}

/**
 * Pure classification. Never throws — an unparseable date is treated as "no
 * data", which is critical, because a date we cannot read is not evidence of
 * freshness.
 */
export function classifyBingLiveness(input: BingLivenessInput): BingLivenessVerdict {
  // An unreachable API is critical NOW. Ageing into it would spend two days
  // pretending we still had a working integration.
  if (!input.reachable) return { status: "critical", dataAgeSeconds: null };

  const ageSeconds = computeDataAgeSeconds(input.maxDataDate, input.now);
  if (ageSeconds == null) return { status: "critical", dataAgeSeconds: null };

  const ageHours = ageSeconds / 3600;
  if (ageHours > BING_CRITICAL_AFTER_HOURS)
    return { status: "critical", dataAgeSeconds: ageSeconds };
  if (ageHours > BING_DEGRADED_AFTER_HOURS)
    return { status: "degraded", dataAgeSeconds: ageSeconds };
  return { status: "green", dataAgeSeconds: ageSeconds };
}

/**
 * Seconds elapsed since the END of the day named by `isoDate` (UTC).
 * Clamped at 0, so data for today or a future-dated row reads as fresh rather
 * than negative. Returns null for null/unparseable input.
 */
export function computeDataAgeSeconds(isoDate: string | null, now: Date): number | null {
  if (!isoDate) return null;
  const dayStart = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(dayStart)) return null;
  const dayEnd = dayStart + DAY_MS;
  return Math.max(0, Math.floor((now.getTime() - dayEnd) / 1000));
}

/** Green resets the streak; anything else extends it. */
export function nextConsecutiveFailures(previous: number, status: BingLivenessStatus): number {
  return status === "green" ? 0 : previous + 1;
}

/** Escalate once the streak reaches the threshold — and on every check after,
 *  matching GA4's behaviour so a persistent outage keeps a fresh timestamp. */
export function shouldAlertOnStreak(consecutiveFailures: number): boolean {
  return consecutiveFailures >= BING_ALERT_AFTER_CONSECUTIVE;
}
