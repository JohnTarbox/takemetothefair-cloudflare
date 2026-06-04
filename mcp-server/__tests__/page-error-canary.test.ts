/**
 * Tests for the page-error canary (issue #326).
 *
 * Focused on the pure decision function `decideTier` — the integration with
 * D1 + Slack + email is glue around it, but the tier+debounce math is where
 * the actual operational semantics live. Pin it down so threshold tuning
 * doesn't accidentally re-fire RED every cron tick during a long outage.
 */
import { describe, expect, it } from "vitest";
import { __test } from "../src/page-error-canary.js";

const {
  decideTier,
  RED_THRESHOLD,
  YELLOW_THRESHOLD,
  RED_DEBOUNCE_MINUTES,
  YELLOW_DEBOUNCE_MINUTES,
} = __test;

const NOW = new Date("2026-06-04T20:00:00Z");

/** Helper: subtract minutes from NOW. */
function minutesAgo(m: number): Date {
  return new Date(NOW.getTime() - m * 60_000);
}

describe("decideTier", () => {
  describe("threshold boundaries", () => {
    it("returns null when count is below YELLOW threshold", () => {
      expect(decideTier(YELLOW_THRESHOLD - 1, null, null, NOW)).toBeNull();
      expect(decideTier(0, null, null, NOW)).toBeNull();
    });

    it("returns YELLOW at exactly the YELLOW threshold", () => {
      expect(decideTier(YELLOW_THRESHOLD, null, null, NOW)).toBe("YELLOW");
    });

    it("returns YELLOW between YELLOW and RED thresholds", () => {
      const between = Math.floor((YELLOW_THRESHOLD + RED_THRESHOLD) / 2);
      expect(decideTier(between, null, null, NOW)).toBe("YELLOW");
    });

    it("returns RED at exactly the RED threshold", () => {
      expect(decideTier(RED_THRESHOLD, null, null, NOW)).toBe("RED");
    });

    it("returns RED above the RED threshold", () => {
      expect(decideTier(RED_THRESHOLD + 100, null, null, NOW)).toBe("RED");
    });
  });

  describe("YELLOW debounce", () => {
    it("suppresses YELLOW when last YELLOW alert was within debounce window", () => {
      const recentYellow = minutesAgo(YELLOW_DEBOUNCE_MINUTES - 1);
      expect(decideTier(YELLOW_THRESHOLD, null, recentYellow, NOW)).toBeNull();
    });

    it("allows YELLOW when last YELLOW alert was outside debounce window", () => {
      const oldYellow = minutesAgo(YELLOW_DEBOUNCE_MINUTES + 1);
      expect(decideTier(YELLOW_THRESHOLD, null, oldYellow, NOW)).toBe("YELLOW");
    });

    it("allows YELLOW when there's never been a YELLOW alert", () => {
      expect(decideTier(YELLOW_THRESHOLD, null, null, NOW)).toBe("YELLOW");
    });
  });

  describe("RED debounce", () => {
    it("suppresses RED when last RED alert was within debounce window", () => {
      const recentRed = minutesAgo(RED_DEBOUNCE_MINUTES - 1);
      expect(decideTier(RED_THRESHOLD, recentRed, null, NOW)).toBeNull();
    });

    it("allows RED when last RED alert was outside debounce window", () => {
      const oldRed = minutesAgo(RED_DEBOUNCE_MINUTES + 1);
      expect(decideTier(RED_THRESHOLD, oldRed, null, NOW)).toBe("RED");
    });
  });

  describe("RED bypasses YELLOW state", () => {
    it("fires RED even when a recent YELLOW alert would have suppressed YELLOW", () => {
      const recentYellow = minutesAgo(5); // way inside YELLOW debounce
      expect(decideTier(RED_THRESHOLD, null, recentYellow, NOW)).toBe("RED");
    });

    it("RED debounce is checked against RED state, not YELLOW state", () => {
      // YELLOW fired 5 minutes ago, RED has never fired — count escalates to RED.
      // The RED debounce check should see no prior RED, so allow RED to fire.
      const recentYellow = minutesAgo(5);
      expect(decideTier(RED_THRESHOLD, null, recentYellow, NOW)).toBe("RED");
    });
  });

  describe("simultaneous debounce of both tiers", () => {
    it("returns null when count is at RED but RED is debounced (does NOT fall back to YELLOW)", () => {
      const recentRed = minutesAgo(1);
      // Even though the count would also exceed YELLOW, RED's own debounce
      // is what gates this — we don't "downgrade" to YELLOW because that
      // would understate the severity in any human-facing log.
      expect(decideTier(RED_THRESHOLD, recentRed, null, NOW)).toBeNull();
    });

    it("returns null when count is at YELLOW and YELLOW is debounced", () => {
      const recentYellow = minutesAgo(1);
      expect(decideTier(YELLOW_THRESHOLD, null, recentYellow, NOW)).toBeNull();
    });
  });
});
