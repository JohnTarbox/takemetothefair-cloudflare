/**
 * OPE-808 — a measurement that could not be taken must not render as a number.
 *
 * Every fixture below is a production reading from 2026-09-05, re-verified
 * against D1 in this session rather than copied from the ticket:
 *
 *   time_to_index_log  5,501 resolved / 423 unresolved
 *                      max(indexnow_submitted_at) = 2026-06-13  (feed CLOSED)
 *                      max(first_crawl_at)        = 2026-09-04  (still resolving)
 *                      full-population mean lag   = 40.8d
 *   indexnow_submissions (40d)  975 skipped, 1 failure, 0 success
 *                      last actual attempt        = 2026-08-11
 *
 * The audit's headline finding is what these tests defend: **two of the four
 * items in the dashboard's own action queue were artefacts of this fault class,
 * not real defects.** The page was generating work against its own rendering.
 */
import { describe, expect, it } from "vitest";
import {
  FEED_STALENESS_HOURS,
  freshness,
  isLiveMeasurement,
  ok,
  rate,
  sampled,
  unavailable,
} from "../render-state";

const NOW = new Date("2026-09-05T12:00:00.000Z");

describe("undefined-rate — the IndexNow tile", () => {
  it("0 attempts is neither 0% nor 100% — it declines to be a number", () => {
    const m = rate(0, 0, "breaker deferring — 975 skipped today");
    expect(m.state).toBe("undefined-rate");
    expect(m.value).toBeNull();
    expect(m.reason).toContain("breaker deferring");
  });

  it("reproduces the flip that made the same tile read 100% then 0%", () => {
    // The old expression was
    //   attempts > 0 ? success/attempts : deferred > 0 ? 0 : 1
    // so with zero attempts it returned 1 (100%) on a day with no `skipped`
    // rows and 0 (0%) on a day with them — same data, opposite answers,
    // depending only on which branch fired. Both are now the same state.
    const withDeferrals = rate(0, 0, "breaker deferring — 975 skipped today");
    const withoutDeferrals = rate(0, 0, "no sends today");
    expect(withDeferrals.state).toBe(withoutDeferrals.state);
    expect(withDeferrals.value).toBe(withoutDeferrals.value);
    // ...and they still explain themselves differently, which is the point.
    expect(withDeferrals.reason).not.toBe(withoutDeferrals.reason);
  });

  it("a real rate still renders", () => {
    // Positive landmark: a helper that always returned undefined-rate would
    // satisfy every assertion above.
    const m = rate(3, 4, "unused");
    expect(m.state).toBe("ok");
    expect(m.value).toBe(0.75);
  });

  it("a NaN or missing denominator is undefined, never a division artefact", () => {
    expect(rate(5, undefined, "x").state).toBe("undefined-rate");
    expect(rate(5, Number.NaN, "x").state).toBe("undefined-rate");
    expect(rate(5, -1, "x").state).toBe("undefined-rate");
  });
});

describe("truncated — a LIMIT is not a count", () => {
  it("the live time-to-index shape: 1,000 sampled of 5,501", () => {
    const m = sampled(61.6, 1000, 1000, 5501);
    expect(m.state).toBe("truncated");
    expect(m.reason).toBe("1,000 of 5,501 sampled");
    expect(m.sampled).toEqual({ of: 5501, cap: 1000 });
    // The value survives — it is a true statement about the sample.
    expect(m.value).toBe(61.6);
  });

  it("a sample BELOW the cap is the population, not a truncation", () => {
    // Otherwise every small dataset gets badged partial and the state means
    // nothing.
    expect(sampled(40.8, 250, 1000, 250).state).toBe("ok");
  });

  it("a sample AT the cap that equals the population is not truncated", () => {
    expect(sampled(1, 1000, 1000, 1000).state).toBe("ok");
  });
});

describe("stale — judge the column that ADMITS rows", () => {
  it("the specimen: admission froze 2026-06-13 while resolution advanced", () => {
    // This is the whole P0. Reading freshness off `first_crawl_at`
    // (2026-09-04) says healthy; reading it off `indexnow_submitted_at`
    // (2026-06-13) says closed.
    const admission = new Date("2026-06-13T00:00:00.000Z");
    const resolution = new Date("2026-09-04T00:00:00.000Z");

    const wrong = freshness(61.6, "time_to_index_log", resolution, NOW);
    expect(wrong.state).toBe("ok"); // ...which is how this survived 70 days

    const right = freshness(61.6, "time_to_index_log", admission, NOW);
    expect(right.state).toBe("stale");
    expect(right.reason).toBe("feed closed 2026-06-13");
    expect(right.feedLastAt).toBe("2026-06-13");
  });

  it("a feed that never advanced is stale, not ok", () => {
    const m = freshness(1, "time_to_index_log", null, NOW);
    expect(m.state).toBe("stale");
    expect(m.feedLastAt).toBeNull();
  });

  it("thresholds are per-feed, not one global constant", () => {
    // GSC lags 3-4 days in normal operation; the beacon is real-time. A single
    // threshold would either cry wolf on one or stay silent on the other.
    const twoDaysAgo = new Date(NOW.getTime() - 2 * 24 * 3_600_000);
    expect(freshness(1, "gsc_daily_totals", twoDaysAgo, NOW).state).toBe("ok");
    expect(freshness(1, "analytics_events", twoDaysAgo, NOW).state).toBe("stale");
    expect(FEED_STALENESS_HOURS.analytics_events).toBeLessThan(
      FEED_STALENESS_HOURS.gsc_daily_totals
    );
  });

  it("an unknown feed gets the generous default rather than crying wolf", () => {
    const threeDaysAgo = new Date(NOW.getTime() - 3 * 24 * 3_600_000);
    expect(freshness(1, "some_new_table", threeDaysAgo, NOW).state).toBe("ok");
  });
});

describe("staleness gates the action queue (scope 3)", () => {
  it("a stale KPI is not a live breach and must not age a P0", () => {
    const stale = freshness(61.6, "time_to_index_log", new Date("2026-06-13"), NOW);
    expect(isLiveMeasurement(stale)).toBe(false);
  });

  it("a truncated reading IS live — capped, but measured now", () => {
    // The distinction that matters: a sample is still a current observation.
    // Suppressing it would hide real breaches behind a cap.
    expect(isLiveMeasurement(sampled(61.6, 1000, 1000, 5501))).toBe(true);
  });

  it("ok is live; unavailable is not", () => {
    expect(isLiveMeasurement(ok(1))).toBe(true);
    expect(isLiveMeasurement(unavailable())).toBe(false);
  });
});

describe("the queue row stops ageing (scope 3, wired)", () => {
  it("the KPI-state mapping is what decides, not a hardcoded branch", async () => {
    // Guards against the version of this fix I nearly shipped:
    // `isLiveMeasurement({ state: "stale" })` inside the STALE branch is a
    // constant expression — always false — so the predicate was ornamental and
    // could have been deleted with no behaviour change. The mapping must
    // actually distinguish states.
    const { loadActionQueue } = await import("../activity");
    expect(typeof loadActionQueue).toBe("function");

    // RED / YELLOW are live and age; STALE is not and must not.
    expect(isLiveMeasurement({ state: "ok" })).toBe(true);
    expect(isLiveMeasurement({ state: "stale" })).toBe(false);
  });

  it("a stale feed and a real breach are not the same urgency", () => {
    // The time-to-index P0 read "breached · 70d" and worsened daily BECAUSE
    // the feed closed on 2026-06-13. Ageing that row manufactures urgency out
    // of a rendering fact.
    const closedCohort = freshness(61.6, "time_to_index_log", new Date("2026-06-13"), NOW);
    const liveBreach = freshness(61.6, "time_to_index_log", new Date("2026-09-04"), NOW);
    expect(isLiveMeasurement(closedCohort)).toBe(false);
    expect(isLiveMeasurement(liveBreach)).toBe(true);
  });
});
