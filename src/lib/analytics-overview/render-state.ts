/**
 * OPE-808 — a measurement that could not be taken must not render as a number.
 *
 * OPE-310 shipped the A4 convention as `UnavailableBadge`, covering exactly one
 * failure mode: a fetch that returned `null`. The 2026-09-05 audit found three
 * more that reach the renderer looking like legitimate readings — and found
 * that **two of the four items in the dashboard's own action queue were
 * artefacts of this fault class rather than real defects.** The page was
 * generating work against its own rendering bugs.
 *
 * The four modes, each verified against production D1 on 2026-09-05:
 *
 * | mode             | live example                                            |
 * | ---------------- | ------------------------------------------------------- |
 * | `unavailable`    | fetch returned null (already handled by A4)             |
 * | `undefined-rate` | `INDEXNOW TODAY — 0 · 100% success`. `0/0` rendered green |
 * | `truncated`      | `1,000 resolved` — a `LIMIT 1000` printed as a count;    |
 * |                  | the store holds 5,501, and the capped sample reports     |
 * |                  | 61.6d against a true population mean of 40.8d            |
 * | `stale`          | `time_to_index_log.indexnow_submitted_at` maxes at       |
 * |                  | 2026-06-13, yet `first_crawl_at` still advances to       |
 * |                  | 2026-09-04 — so the median CLIMBS mechanically as the    |
 * |                  | slowest stragglers land, and the KPI can only worsen     |
 * |                  | regardless of real indexing performance                  |
 *
 * ## Why these are one module and not four fixes
 *
 * Because the convention drifted once already. A4 exists, is correct, and was
 * applied to three GSC tiles; every tile added since has been free to invent
 * its own fallback. `?? 0` is not a rendering choice, it is an assertion that
 * the measurement was taken and came back zero.
 *
 * ⚠️ The rule this encodes: **a number on this page means "we measured this".**
 * Anything else — no data, no denominator, a capped sample, a feed that stopped
 * — has to say which. That is the same principle as OPE-804's `dedupWasBlind`
 * and OPE-811's unfiled backlog: an absent signal and a negative signal must
 * not share one representation.
 */

/** What a rendered measurement is actually telling you. */
export type MeasurementState =
  | "ok"
  /** The fetch failed. Nothing was measured. */
  | "unavailable"
  /** The denominator was zero — a rate over an empty population. */
  | "undefined-rate"
  /** A `LIMIT` was hit; the figure describes a sample, not the population. */
  | "truncated"
  /** The backing store stopped advancing; the figure describes a closed cohort. */
  | "stale";

export interface Measurement<T = number> {
  state: MeasurementState;
  /** Present only when `state === "ok"` (or as the sample value when truncated). */
  value: T | null;
  /**
   * Human-readable reason, rendered next to (or instead of) the value.
   * Always names the CAUSE, never just "n/a" — an operator seeing "—" learns
   * nothing, and this dashboard's whole failure mode was uninformative displays.
   */
  reason: string;
  /** For `truncated`: the sample size and the true population. */
  sampled?: { of: number; cap: number };
  /** For `stale`: the last date the feed advanced, as `YYYY-MM-DD`. */
  feedLastAt?: string | null;
}

export function ok<T>(value: T): Measurement<T> {
  return { state: "ok", value, reason: "" };
}

export function unavailable<T = number>(reason = "no data"): Measurement<T> {
  return { state: "unavailable", value: null, reason };
}

/**
 * A rate that refuses to exist without a denominator.
 *
 * `0/0` is not 100%, and it is not 0% either — both were observed on the same
 * IndexNow tile on the same day, from the same data, because the expression
 * differed by which fallback happened to fire. It is "we sent nothing".
 *
 * @param reason why the population is empty, e.g. "paused since 2026-08-11".
 *   Required, and deliberately so: an undefined rate with no explanation is the
 *   bare `—` this ticket exists to remove.
 */
export function rate(
  numerator: number | null | undefined,
  denominator: number | null | undefined,
  reason: string
): Measurement<number> {
  const d = typeof denominator === "number" && Number.isFinite(denominator) ? denominator : 0;
  const n = typeof numerator === "number" && Number.isFinite(numerator) ? numerator : 0;
  if (d <= 0) return { state: "undefined-rate", value: null, reason };
  return ok(n / d);
}

/**
 * A figure computed over a capped sample.
 *
 * `sampleSize < cap` means the cap was never reached, so the sample IS the
 * population and the reading is `ok`. Only a sample that actually hit the cap
 * is truncated — otherwise every small dataset would be badged as partial.
 */
export function sampled(
  value: number | null,
  sampleSize: number,
  cap: number,
  populationTotal: number
): Measurement<number> {
  if (sampleSize < cap || populationTotal <= sampleSize) return ok(value as number);
  return {
    state: "truncated",
    value,
    reason: `${sampleSize.toLocaleString()} of ${populationTotal.toLocaleString()} sampled`,
    sampled: { of: populationTotal, cap },
  };
}

/**
 * Per-feed staleness thresholds, in hours (OPE-808 scope 4).
 *
 * Table-driven rather than one global constant, because the feeds have
 * genuinely different cadences and a single threshold would either cry wolf on
 * GSC or stay silent on the beacon:
 *
 *   - `gsc_daily_totals` lags 3–4 days in normal operation — Google's own
 *     reporting delay, not our failure.
 *   - `time_to_index_log` is admitted by IndexNow submission, which is paused,
 *     so it should flag within days.
 *   - the analytics beacon is real-time; an hour of silence is a defect.
 */
export const FEED_STALENESS_HOURS: Record<string, number> = {
  gsc_daily_totals: 24 * 6,
  time_to_index_log: 24 * 3,
  analytics_events: 6,
  indexnow_submissions: 24 * 2,
  fault_signatures: 24 * 7,
};

/** Default when a feed is not in the table — deliberately generous. */
export const DEFAULT_STALENESS_HOURS = 24 * 7;

/**
 * Is the store still advancing?
 *
 * ⚠️ Judge freshness on the column that ADMITS rows, not on any column that
 * still changes. `time_to_index_log` is the specimen: `indexnow_submitted_at`
 * (admission) froze on 2026-06-13, while `first_crawl_at` (resolution) keeps
 * moving to 2026-09-04. Reading freshness off the second one says the feed is
 * healthy, and the median climbs mechanically as the slowest stragglers land —
 * a KPI that can only worsen no matter how indexing actually performs.
 */
export function freshness<T>(
  value: T,
  feed: string,
  feedAdmitsRowsAt: Date | number | null | undefined,
  now: Date = new Date()
): Measurement<T> {
  if (feedAdmitsRowsAt == null) {
    return { state: "stale", value, reason: `${feed} has never advanced`, feedLastAt: null };
  }
  const ms = feedAdmitsRowsAt instanceof Date ? feedAdmitsRowsAt.getTime() : feedAdmitsRowsAt;
  if (!Number.isFinite(ms)) {
    return { state: "stale", value, reason: `${feed} timestamp unreadable`, feedLastAt: null };
  }
  const iso = new Date(ms).toISOString().slice(0, 10);
  const hours = (now.getTime() - ms) / 3_600_000;
  const limit = FEED_STALENESS_HOURS[feed] ?? DEFAULT_STALENESS_HOURS;
  if (hours <= limit) return ok(value);
  return {
    state: "stale",
    value,
    reason: `feed closed ${iso}`,
    feedLastAt: iso,
  };
}

/**
 * Does this measurement describe live reality?
 *
 * The action queue asks this before raising or ageing a P0 (scope 3). A KPI on
 * a frozen feed is not a breach — the time-to-index P0 has read
 * "breached · 70d" since 2026-06-27 and gets worse every day *because* the feed
 * closed, so ageing it manufactures urgency out of a rendering bug.
 */
export function isLiveMeasurement(m: Pick<Measurement<unknown>, "state">): boolean {
  return m.state === "ok" || m.state === "truncated";
}

/** The chip the Overview legend already promises but nothing rendered. */
export const STALE_CHIP = "🕒";
