/**
 * OPE-243 — the integration-silence detector. IndexNow was silent for 20 days
 * with 12k URLs queued and nothing escalated; these lock the decision that
 * would have flagged it at 24h, and guard against the false positives that
 * would make an operator mute it (idle-when-nothing-queued must stay quiet).
 */
import { describe, it, expect } from "vitest";
import {
  assessIntegrationSilence,
  assessAllIntegrationSilence,
  INTEGRATION_SILENCE_THRESHOLD_HOURS,
  type IntegrationActivity,
} from "../integration-silence";

const NOW = new Date("2026-07-18T00:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function base(over: Partial<IntegrationActivity> = {}): IntegrationActivity {
  return {
    name: "IndexNow (Bing)",
    refKey: "integration-silence:indexnow",
    href: "https://meetmeatthefair.com/admin/analytics?tab=site-health",
    lastSuccessAt: hoursAgo(2),
    silentSinceAt: hoursAgo(2),
    shouldBeActive: true,
    activeReason: "12000 URL(s) queued; Bing monthly quota 1500/1500 unspent",
    ...over,
  };
}

describe("assessIntegrationSilence (OPE-243)", () => {
  it("healthy: a recent success is not a red", () => {
    expect(assessIntegrationSilence(base({ lastSuccessAt: hoursAgo(2) }), NOW)).toBeNull();
  });

  it("RED: silent past the 24h threshold while work is queued (the 20-day case)", () => {
    const red = assessIntegrationSilence(base({ lastSuccessAt: hoursAgo(20 * 24) }), NOW);
    expect(red).not.toBeNull();
    expect(red!.priority).toBe("P1");
    expect(red!.title).toContain("IndexNow (Bing)");
    expect(red!.title).toContain("~20d");
    expect(Math.round(red!.hoursInRed)).toBe(20 * 24);
  });

  it("stays QUIET when there's nothing to send (shouldBeActive=false) — no false alarm on an idle day", () => {
    expect(
      assessIntegrationSilence(
        base({ lastSuccessAt: hoursAgo(20 * 24), shouldBeActive: false }),
        NOW
      )
    ).toBeNull();
  });

  it("does not fire just under the threshold, fires just over", () => {
    const under = INTEGRATION_SILENCE_THRESHOLD_HOURS - 0.5;
    const over = INTEGRATION_SILENCE_THRESHOLD_HOURS + 0.5;
    expect(assessIntegrationSilence(base({ lastSuccessAt: hoursAgo(under) }), NOW)).toBeNull();
    expect(assessIntegrationSilence(base({ lastSuccessAt: hoursAgo(over) }), NOW)).not.toBeNull();
  });

  it("never-succeeded: ages from silentSinceAt and says so", () => {
    const red = assessIntegrationSilence(
      base({ lastSuccessAt: null, silentSinceAt: hoursAgo(72) }),
      NOW
    );
    expect(red).not.toBeNull();
    expect(red!.title).toContain("no success on record");
    expect(red!.firstDetectedAt).toBe(hoursAgo(72).toISOString());
  });

  it("no anchor at all (no success, no silentSince) → don't cry wolf", () => {
    expect(
      assessIntegrationSilence(base({ lastSuccessAt: null, silentSinceAt: null }), NOW)
    ).toBeNull();
  });

  it("honors a per-integration threshold override", () => {
    const a = base({ lastSuccessAt: hoursAgo(30), thresholdHours: 48 });
    expect(assessIntegrationSilence(a, NOW)).toBeNull(); // 30h < 48h override
  });
});

describe("assessAllIntegrationSilence", () => {
  it("returns only the silent ones", () => {
    const reds = assessAllIntegrationSilence(
      [
        base({ refKey: "a", lastSuccessAt: hoursAgo(1) }), // healthy
        base({ refKey: "b", lastSuccessAt: hoursAgo(100) }), // silent
        base({ refKey: "c", shouldBeActive: false, lastSuccessAt: hoursAgo(100) }), // idle
      ],
      NOW
    );
    expect(reds.map((r) => r.refKey)).toEqual(["b"]);
  });
});
