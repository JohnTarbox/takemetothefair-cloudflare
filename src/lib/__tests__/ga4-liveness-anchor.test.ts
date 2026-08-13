/**
 * The GA4 liveness check spent 98 days unable to return green.
 *
 * Measured in production 2026-08-12: `ga4_liveness_log` held 97 rows spanning
 * 2026-05-06 -> 2026-08-12, ALL `degraded`, with data_age_seconds = 30.0h on
 * every single row, and `ga4.liveness_alert` had fired 96 times.
 *
 * GA4 was healthy throughout. The age was anchored at MIDNIGHT of the data
 * date; the check runs at 06:00Z; GA4's freshest complete day is "yesterday".
 * So the minimum observable age was 30h against a 24h degraded threshold —
 * green was unreachable by construction.
 *
 * These tests replay the real rows. Under the old start-of-day anchor the
 * first block fails; under the corrected end-of-day anchor it passes.
 */
import { describe, it, expect } from "vitest";
import { computeAgeSeconds } from "@/lib/ga4-liveness";

// Thresholds are unchanged by the fix — they are what the route compares against.
const DEGRADED_THRESHOLD_SECONDS = 24 * 3600;
const CRITICAL_THRESHOLD_SECONDS = 48 * 3600;

const statusFor = (age: number | null): "green" | "degraded" | "critical" => {
  if (age == null || age > CRITICAL_THRESHOLD_SECONDS) return "critical";
  if (age > DEGRADED_THRESHOLD_SECONDS) return "degraded";
  return "green";
};

describe("GA4 liveness anchor — the 97 poisoned rows", () => {
  // (checked_at, max_data_date) lifted verbatim from ga4_liveness_log.
  const REAL_ROWS: ReadonlyArray<readonly [string, string]> = [
    ["2026-08-12T06:01:01Z", "2026-08-11"],
    ["2026-08-11T06:01:01Z", "2026-08-10"],
    ["2026-08-10T06:00:23Z", "2026-08-09"],
    ["2026-08-09T06:00:11Z", "2026-08-08"],
    ["2026-08-08T06:00:13Z", "2026-08-07"],
    ["2026-08-07T06:00:07Z", "2026-08-06"],
    ["2026-08-06T06:00:07Z", "2026-08-05"],
    ["2026-08-05T06:00:08Z", "2026-08-04"],
    ["2026-05-06T06:01:01Z", "2026-05-05"],
  ];

  it("reports GREEN for every real row that was recorded as degraded", () => {
    for (const [checkedAt, maxDataDate] of REAL_ROWS) {
      const age = computeAgeSeconds(maxDataDate, new Date(checkedAt));
      expect(statusFor(age), `row checked ${checkedAt} data ${maxDataDate}`).toBe("green");
    }
  });

  it("measures 6h, not the 30h every poisoned row recorded", () => {
    // 30h is the fingerprint of the bug: it is what a midnight anchor yields
    // for yesterday's data at 06:00Z, and it appeared on all 97 rows.
    const age = computeAgeSeconds("2026-08-11", new Date("2026-08-12T06:01:01Z"));
    expect(age).toBe(6 * 3600 + 61);
    expect(age).toBeLessThan(DEGRADED_THRESHOLD_SECONDS);
  });
});

describe("GA4 liveness anchor — genuine staleness still escalates", () => {
  const CRON = new Date("2026-08-12T06:00:00Z");

  it("is DEGRADED when a day is genuinely missing", () => {
    expect(statusFor(computeAgeSeconds("2026-08-10", CRON))).toBe("degraded");
  });

  it("is CRITICAL when two days are missing", () => {
    expect(statusFor(computeAgeSeconds("2026-08-09", CRON))).toBe("critical");
  });

  it("is CRITICAL when GA4 returns no dated data at all", () => {
    // The real outage this check exists for (2026-04-27 -> 2026-05-05) presents
    // as a null max date. The fix must not have blunted that.
    expect(statusFor(computeAgeSeconds(null, CRON))).toBe("critical");
  });

  it("clamps same-day and future-dated rows to zero instead of going negative", () => {
    expect(computeAgeSeconds("2026-08-12", CRON)).toBe(0);
    expect(computeAgeSeconds("2026-09-01", CRON)).toBe(0);
  });

  it("returns null for an unparseable date", () => {
    expect(computeAgeSeconds("2026-13-45", CRON)).toBeNull();
  });
});
