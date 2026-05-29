/**
 * Tests for the tier classification + concern % math on
 * /admin/promoter-quality (analyst J5, 2026-05-29 PM).
 *
 * The page is a server component; we test the pure helpers it relies
 * on by importing them through a thin proxy. Since the helpers are
 * not exported (they're inline in the page module), we duplicate the
 * classifyTier function here — same shape, same thresholds — and run
 * the boundary cases. When promoter-quality eventually needs a shared
 * library (for tier-aware auto-approval), the helper moves out of the
 * page and this test imports it directly.
 */

import { describe, expect, it } from "vitest";

type Tier = "T1" | "T2" | "T3";

const MIN_EVENTS_FOR_TIER = 3;

function classifyTier(concernPct: number, total: number): Tier {
  if (total < MIN_EVENTS_FOR_TIER) return "T2";
  if (concernPct >= 25) return "T3";
  if (concernPct >= 10) return "T2";
  return "T1";
}

describe("classifyTier — boundary cases", () => {
  it("returns T2 when total < MIN_EVENTS_FOR_TIER regardless of concern %", () => {
    expect(classifyTier(0, 0)).toBe("T2");
    expect(classifyTier(0, 1)).toBe("T2");
    expect(classifyTier(0, 2)).toBe("T2");
    expect(classifyTier(100, 1)).toBe("T2"); // even 100% concern at tiny sample → watch
    expect(classifyTier(50, 2)).toBe("T2");
  });

  it("returns T3 at the 25% boundary (exact and above)", () => {
    expect(classifyTier(25, 10)).toBe("T3");
    expect(classifyTier(25.1, 10)).toBe("T3");
    expect(classifyTier(50, 100)).toBe("T3");
    expect(classifyTier(100, 5)).toBe("T3");
  });

  it("returns T2 in the 10..<25 band", () => {
    expect(classifyTier(10, 10)).toBe("T2");
    expect(classifyTier(15, 10)).toBe("T2");
    expect(classifyTier(24.9, 10)).toBe("T2");
  });

  it("returns T1 below 10% (well-behaved promoters)", () => {
    expect(classifyTier(0, 10)).toBe("T1");
    expect(classifyTier(5, 10)).toBe("T1");
    expect(classifyTier(9.9, 10)).toBe("T1");
  });

  it("MIN_EVENTS_FOR_TIER boundary: 3 events qualifies for full classification", () => {
    // At exactly 3 events the promoter passes the floor and gets a
    // real tier based on concern %.
    expect(classifyTier(0, 3)).toBe("T1");
    expect(classifyTier(33.4, 3)).toBe("T3"); // 1 of 3 concerns
    expect(classifyTier(15, 3)).toBe("T2"); // edge of T2
  });
});

describe("classifyTier — operational scenarios", () => {
  it("clean state-fair promoter: high volume, low concern → T1", () => {
    // 30 events / 1 cancelled = 3.3% concern; should be T1
    expect(classifyTier(3.3, 30)).toBe("T1");
  });

  it("flaky community promoter: ~15% concern → T2 watch", () => {
    // 20 events / 1 cancelled + 1 postponed + 1 gate-flagged = 15%
    expect(classifyTier(15, 20)).toBe("T2");
  });

  it("repeatedly-cancelled promoter: 40% concern → T3 risky", () => {
    expect(classifyTier(40, 10)).toBe("T3");
  });

  it("brand-new promoter with one rejected event: default T2 not T3", () => {
    // Even though concern % is 100, the tiny sample means we default
    // to watch — not enough signal to flag as definitely risky.
    expect(classifyTier(100, 1)).toBe("T2");
  });
});
