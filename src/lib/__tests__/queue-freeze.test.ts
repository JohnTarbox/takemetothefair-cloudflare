/**
 * OPE-247 — the pure frozen/slow-drain decision. Mirrors integration-silence.test.
 */
import { describe, it, expect } from "vitest";
import {
  assessQueueFreeze,
  assessAllQueueFreeze,
  FROZEN_ZERO_OUTFLOW_DAYS,
  SLOW_DRAIN_RATIO_THRESHOLD,
  type QueueFlow,
} from "@/lib/queue-freeze";

const NOW = new Date("2026-07-20T00:00:00Z");

const flow = (over: Partial<QueueFlow> = {}): QueueFlow => ({
  queueName: "event_discrepancies",
  label: "Event discrepancies",
  href: "/admin/analytics#queue-drain-ratios",
  depth: 100,
  inflow7d: 20,
  outflow7d: 10,
  inflow14d: 40,
  outflow14d: 25,
  oldestOpenAgeHours: 30 * 24,
  ...over,
});

describe("assessQueueFreeze", () => {
  it("an empty queue is never frozen", () => {
    expect(assessQueueFreeze(flow({ depth: 0, outflow7d: 0 }), NOW)).toBeNull();
  });

  it("returns null when outflow is not yet computable (inbound w/o history)", () => {
    expect(assessQueueFreeze(flow({ outflow7d: null, outflow14d: null }), NOW)).toBeNull();
  });

  it("FROZEN: depth>0 and zero outflow over the window → P1 red", () => {
    const red = assessQueueFreeze(flow({ depth: 5890, outflow7d: 0 }), NOW);
    expect(red).not.toBeNull();
    expect(red!.priority).toBe("P1");
    expect(red!.title).toContain("frozen");
    expect(red!.title).toContain("5890");
    expect(red!.refKey).toBe("queue-freeze:event_discrepancies");
    // hoursInRed comes from the oldest-open age (30d here).
    expect(red!.hoursInRed).toBeCloseTo(30 * 24, 0);
  });

  it("SLOW DRAIN: drain ratio below threshold over 14d → red", () => {
    // 3 out / 40 in = 0.075 < 0.5
    const red = assessQueueFreeze(flow({ outflow7d: 2, inflow14d: 40, outflow14d: 3 }), NOW);
    expect(red).not.toBeNull();
    expect(red!.title).toContain("drain ratio");
    expect(red!.title).toContain("0.07"); // 3/40 = 0.075 → toFixed(2) = "0.07"
  });

  it("healthy drain (ratio at/above threshold) → null", () => {
    // 25 out / 40 in = 0.625 >= 0.5, and outflow7d>0 so not frozen
    expect(
      assessQueueFreeze(flow({ outflow7d: 10, inflow14d: 40, outflow14d: 25 }), NOW)
    ).toBeNull();
  });

  it("does not slow-drain-fire when there was no inflow over 14d", () => {
    // depth>0 but nothing arriving AND some outflow → not frozen, ratio undefined
    expect(assessQueueFreeze(flow({ outflow7d: 1, inflow14d: 0, outflow14d: 0 }), NOW)).toBeNull();
  });

  it("frozen takes precedence over slow-drain (zero outflow)", () => {
    const red = assessQueueFreeze(flow({ outflow7d: 0, inflow14d: 40, outflow14d: 0 }), NOW);
    expect(red!.title).toContain("frozen");
  });

  it("exposes the tuning constants", () => {
    expect(FROZEN_ZERO_OUTFLOW_DAYS).toBe(7);
    expect(SLOW_DRAIN_RATIO_THRESHOLD).toBe(0.5);
  });
});

describe("assessAllQueueFreeze", () => {
  it("returns only the unhealthy queues", () => {
    const reds = assessAllQueueFreeze(
      [
        flow({ queueName: "event_discrepancies", depth: 5890, outflow7d: 0 }), // frozen
        flow({ queueName: "vendor_enrichment", outflow7d: 10, outflow14d: 25, inflow14d: 40 }), // healthy
        flow({ queueName: "inbound_exceptions", outflow7d: null }), // unknown → skip
      ],
      NOW
    );
    expect(reds.map((r) => r.refKey)).toEqual(["queue-freeze:event_discrepancies"]);
  });
});
