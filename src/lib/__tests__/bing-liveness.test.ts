/**
 * OPE-309 (A5) — the pure Bing liveness decision.
 *
 * The regression these tests exist to prevent is the one measured in
 * `ga4_liveness_log`: 97 consecutive `degraded` rows over 98 days, every one
 * with data_age = 30.0h, because the age was anchored at the START of the data
 * day and compared against a 24h threshold it could never satisfy. The
 * "healthy steady state is GREEN" case below is that bug, pinned.
 */
import { describe, it, expect } from "vitest";
import {
  BING_ALERT_AFTER_CONSECUTIVE,
  classifyBingLiveness,
  computeDataAgeSeconds,
  nextConsecutiveFailures,
  shouldAlertOnStreak,
} from "@/lib/bing-liveness";

/** The real cron time: 06:00Z, the hour the daily batch fires. */
const CRON_TIME = new Date("2026-08-12T06:00:00Z");

const classify = (maxDataDate: string | null, reachable = true, now = CRON_TIME) =>
  classifyBingLiveness({ maxDataDate, reachable, now });

describe("classifyBingLiveness — steady state", () => {
  it("is GREEN when the newest row is yesterday (the measured healthy state)", () => {
    // Bing's real series (2026-04-30 → 2026-08-11, no gaps) always has the
    // previous day as its newest row. If this ever reads non-green, the probe
    // is miscalibrated — which is precisely the GA4 defect.
    const v = classify("2026-08-11");
    expect(v.status).toBe("green");
    expect(v.dataAgeSeconds).toBe(6 * 3600); // 6h past the end of 08-11
  });

  it("is GREEN for a same-day row, with age clamped at zero", () => {
    const v = classify("2026-08-12");
    expect(v.status).toBe("green");
    expect(v.dataAgeSeconds).toBe(0);
  });

  it("would have been GREEN on every day GA4's check called itself degraded", () => {
    // Same shape as the 97 poisoned GA4 rows: checked 06:00Z, data = yesterday.
    for (const [checked, data] of [
      ["2026-08-12T06:01:01Z", "2026-08-11"],
      ["2026-08-11T06:01:01Z", "2026-08-10"],
      ["2026-08-05T06:00:08Z", "2026-08-04"],
      ["2026-05-06T06:01:01Z", "2026-05-05"],
    ] as const) {
      expect(classify(data, true, new Date(checked)).status).toBe("green");
    }
  });
});

describe("classifyBingLiveness — degradation", () => {
  it("is DEGRADED when exactly one day is missing", () => {
    const v = classify("2026-08-10");
    expect(v.status).toBe("degraded");
    expect(v.dataAgeSeconds).toBe(30 * 3600);
  });

  it("is CRITICAL when two days are missing", () => {
    const v = classify("2026-08-09");
    expect(v.status).toBe("critical");
    expect(v.dataAgeSeconds).toBe(54 * 3600);
  });

  it("is CRITICAL when the API is unreachable, without waiting to age in", () => {
    // A dead credential is ours to fix and must not masquerade as fresh data
    // for two days. Note the date is FRESH here — reachability alone decides.
    const v = classify("2026-08-11", false);
    expect(v.status).toBe("critical");
    expect(v.dataAgeSeconds).toBeNull();
  });

  it("is CRITICAL when no data comes back at all", () => {
    expect(classify(null).status).toBe("critical");
  });

  it("is CRITICAL for an unparseable date rather than trusting it", () => {
    expect(classify("not-a-date").status).toBe("critical");
  });
});

describe("computeDataAgeSeconds — the anchor that GA4 got wrong", () => {
  it("anchors at the END of the data day, not the start", () => {
    // Start-anchored (the GA4 bug) this would be 30h; end-anchored it is 6h.
    expect(computeDataAgeSeconds("2026-08-11", CRON_TIME)).toBe(6 * 3600);
  });

  it("clamps a future-dated row to zero instead of going negative", () => {
    expect(computeDataAgeSeconds("2026-09-01", CRON_TIME)).toBe(0);
  });

  it("returns null for null/garbage input", () => {
    expect(computeDataAgeSeconds(null, CRON_TIME)).toBeNull();
    expect(computeDataAgeSeconds("", CRON_TIME)).toBeNull();
    expect(computeDataAgeSeconds("2026-13-45", CRON_TIME)).toBeNull();
  });
});

describe("consecutive-failure streak", () => {
  it("resets to zero on green", () => {
    expect(nextConsecutiveFailures(96, "green")).toBe(0);
  });

  it("extends on degraded and critical", () => {
    expect(nextConsecutiveFailures(0, "degraded")).toBe(1);
    expect(nextConsecutiveFailures(1, "critical")).toBe(2);
  });

  it("does not alert on a single bad check", () => {
    expect(shouldAlertOnStreak(1)).toBe(false);
  });

  it("alerts once the streak reaches the threshold, and stays alerting", () => {
    expect(shouldAlertOnStreak(BING_ALERT_AFTER_CONSECUTIVE)).toBe(true);
    expect(shouldAlertOnStreak(BING_ALERT_AFTER_CONSECUTIVE + 40)).toBe(true);
  });

  it("a healthy run cannot leave a streak behind", () => {
    // Guards the 97-and-climbing counter: one green check must zero it.
    let streak = 97;
    streak = nextConsecutiveFailures(streak, "green");
    expect(shouldAlertOnStreak(streak)).toBe(false);
  });
});
