/**
 * OPE-391 Block D1 — traffic, led by ORGANIC SESSIONS.
 *
 * Not raw active users. The 2026-05-25 review established that the raw figure
 * is inflated by `(direct)` and bot traffic, so a health page leading with it
 * would show growth that nobody browsing the site would recognise. This calls
 * the same `getOrganicSessions` the §6.3 conversion-rate card uses, so the two
 * surfaces cannot drift apart and quote different "sessions" at each other.
 *
 * The 2-day lag mirrors `analytics-overview/conversions.ts`: GA4 back-fills
 * for roughly 48 hours, so a window ending now makes the most recent days
 * read low and a week-over-week delta invent a decline that is really just
 * unfinished data.
 *
 * `sessions === null` means GA4 errored or is misconfigured. It is propagated,
 * never coerced to 0 — a zero here would render as "no traffic", which is a
 * far more alarming and entirely wrong claim than "we could not measure".
 */
import { getOrganicSessions, type Ga4Env } from "@/lib/ga4";

/** GA4 finalization lag, in days. Matches the conversion-rate card. */
const STABLE_LAG_DAYS = 2;

export interface TrafficReport {
  windowDays: number;
  /** Organic sessions in the most recent complete window. */
  current: number | null;
  /** The window immediately before it, for the WoW delta. */
  previous: number | null;
  /** Fractional change, or null when either side is unmeasured. */
  deltaPct: number | null;
  /** ISO date the measured window ends (lag-adjusted). */
  windowEndDate: string;
}

export async function getTrafficReport(
  env: Ga4Env,
  opts: { windowDays?: number; now?: Date } = {}
): Promise<TrafficReport> {
  const windowDays = opts.windowDays ?? 7;
  const nowMs = (opts.now ?? new Date()).getTime();
  const dayMs = 86_400_000;

  // OPE-1161 B8 — GA4 date ranges include BOTH end dates. The old arithmetic
  // (start = end − 7d, prevEnd = start) made each "7d" window 8 calendar days
  // and gave the two windows a shared day. `windowDays` inclusive days, then
  // the previous window ends the day before this one starts.
  const endMs = nowMs - STABLE_LAG_DAYS * dayMs;
  const startMs = endMs - (windowDays - 1) * dayMs;
  const prevEndMs = startMs - dayMs;
  const prevStartMs = prevEndMs - (windowDays - 1) * dayMs;
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  const [current, previous] = await Promise.all([
    getOrganicSessions(env, fmt(startMs), fmt(endMs)),
    getOrganicSessions(env, fmt(prevStartMs), fmt(prevEndMs)),
  ]);

  // Both sides must be real numbers AND the base non-zero. A previous window
  // of 0 gives an infinite percentage, which renders as nonsense.
  const deltaPct =
    current == null || previous == null || previous === 0 ? null : (current - previous) / previous;

  return { windowDays, current, previous, deltaPct, windowEndDate: fmt(endMs) };
}
