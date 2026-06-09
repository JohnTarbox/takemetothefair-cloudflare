/**
 * Tests for the standing-failure detector (A5, 2026-06-08).
 *
 * Focused on the pure decision function `decideStandingFailure` — the
 * integration with D1, Slack, and email is glue around it. The day-count
 * threshold + "today must be present" rule + debounce math is where the
 * operational semantics live; pin them down so a future threshold tune
 * doesn't accidentally re-fire weekly during a sustained outage.
 */
import { describe, expect, it } from "vitest";
import { __test, type DailyCount } from "../src/standing-failure-canary.js";

const { decideStandingFailure, utcDayKey, MIN_DAY_COUNT, DEBOUNCE_DAYS, WINDOW_DAYS } = __test;

const NOW = new Date("2026-06-08T06:30:00Z");
const TODAY = utcDayKey(NOW);

/** Helper: build a DailyCount[] with `count` per day for the last `n`
 *  calendar days from NOW. Most recent day first (matches the SQL
 *  GROUP BY ordering in the detector). */
function lastNDays(n: number, count = 1): DailyCount[] {
  const out: DailyCount[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      day: utcDayKey(new Date(NOW.getTime() - i * 86400_000)),
      count,
    });
  }
  return out;
}

/** Helper: subtract days from NOW. */
function daysAgo(d: number): Date {
  return new Date(NOW.getTime() - d * 86400_000);
}

describe("decideStandingFailure", () => {
  describe("threshold (≥ MIN_DAY_COUNT distinct days)", () => {
    it("does not fire on 1 day", () => {
      expect(decideStandingFailure(lastNDays(1), null, TODAY, NOW)).toBeNull();
    });

    it("does not fire on 2 days", () => {
      expect(decideStandingFailure(lastNDays(2), null, TODAY, NOW)).toBeNull();
    });

    it("fires at exactly MIN_DAY_COUNT days when today is one of them", () => {
      const decision = decideStandingFailure(lastNDays(MIN_DAY_COUNT), null, TODAY, NOW);
      expect(decision).not.toBeNull();
      expect(decision?.dayCount).toBe(MIN_DAY_COUNT);
      expect(decision?.totalCount).toBe(MIN_DAY_COUNT); // 1 error per day
    });

    it("fires for 7 days (full window)", () => {
      const decision = decideStandingFailure(lastNDays(WINDOW_DAYS), null, TODAY, NOW);
      expect(decision).not.toBeNull();
      expect(decision?.dayCount).toBe(WINDOW_DAYS);
    });

    it("totalCount sums across days", () => {
      const counts: DailyCount[] = [
        { day: utcDayKey(daysAgo(0)), count: 5 },
        { day: utcDayKey(daysAgo(1)), count: 3 },
        { day: utcDayKey(daysAgo(2)), count: 2 },
      ];
      const decision = decideStandingFailure(counts, null, TODAY, NOW);
      expect(decision?.totalCount).toBe(10);
    });
  });

  describe("today-must-be-present rule", () => {
    it("does not fire when 7-day-old issue stops today", () => {
      // Source recurred Mon-Sat (6 days) but is silent on Sun (today).
      const days: DailyCount[] = [];
      for (let i = 1; i <= 6; i++) {
        days.push({ day: utcDayKey(daysAgo(i)), count: 1 });
      }
      expect(decideStandingFailure(days, null, TODAY, NOW)).toBeNull();
    });

    it("does fire when today is in the set", () => {
      const days: DailyCount[] = [
        { day: utcDayKey(daysAgo(0)), count: 1 }, // today
        { day: utcDayKey(daysAgo(1)), count: 1 },
        { day: utcDayKey(daysAgo(2)), count: 1 },
      ];
      expect(decideStandingFailure(days, null, TODAY, NOW)).not.toBeNull();
    });
  });

  describe("per-source debounce (DEBOUNCE_DAYS)", () => {
    it("suppresses when last alert was within debounce window", () => {
      const recent = daysAgo(DEBOUNCE_DAYS - 1);
      expect(decideStandingFailure(lastNDays(5), recent, TODAY, NOW)).toBeNull();
    });

    it("allows when last alert was at debounce edge", () => {
      // Exactly the cutoff: lastAlertedAt < debounceCutoff → fire.
      // We need an alert that is OLDER than the cutoff.
      const older = new Date(daysAgo(DEBOUNCE_DAYS).getTime() - 1000);
      expect(decideStandingFailure(lastNDays(5), older, TODAY, NOW)).not.toBeNull();
    });

    it("allows when never alerted before", () => {
      expect(decideStandingFailure(lastNDays(5), null, TODAY, NOW)).not.toBeNull();
    });

    it("suppresses even a 7-day recurring issue if already alerted yesterday", () => {
      // The REL3 case: recurring every day in the window, but we alerted
      // yesterday — let the 7-day debounce hold so we don't spam.
      const yesterday = daysAgo(1);
      expect(decideStandingFailure(lastNDays(7), yesterday, TODAY, NOW)).toBeNull();
    });
  });

  describe("interaction — debounce + threshold + today rule", () => {
    it("REL3-shaped synthetic: 22-day standing failure fires on first ever evaluation", () => {
      // Mimics REL3's exact pattern: one error per day for many days, never
      // alerted before. The pure function only sees the in-window slice; the
      // SQL query truncates to 7 days. But it MUST fire on this shape.
      const counts = lastNDays(WINDOW_DAYS, 1);
      const decision = decideStandingFailure(counts, null, TODAY, NOW);
      expect(decision).not.toBeNull();
      expect(decision?.dayCount).toBe(WINDOW_DAYS);
      expect(decision?.totalCount).toBe(WINDOW_DAYS);
    });

    it("does not fire on different sources happening on the same day", () => {
      // This is a guarantee at the SQL layer (GROUP BY source, day) — the
      // pure function takes per-source slices already. Just confirm two
      // sources sharing days don't bleed into each other in the caller's
      // unit model.
      const sourceA = lastNDays(2);
      const sourceB = lastNDays(2);
      expect(decideStandingFailure(sourceA, null, TODAY, NOW)).toBeNull();
      expect(decideStandingFailure(sourceB, null, TODAY, NOW)).toBeNull();
    });
  });
});

describe("utcDayKey", () => {
  it("formats a date as YYYY-MM-DD in UTC", () => {
    expect(utcDayKey(new Date("2026-06-08T06:30:00Z"))).toBe("2026-06-08");
    expect(utcDayKey(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-31");
  });

  it("UTC boundary — same key for local midnight in different TZs", () => {
    // The detector always thinks in UTC. A timestamp 5 minutes past UTC
    // midnight is the same "day" as one 5 hours later.
    const a = new Date("2026-06-08T00:05:00Z");
    const b = new Date("2026-06-08T05:05:00Z");
    expect(utcDayKey(a)).toBe(utcDayKey(b));
  });
});
