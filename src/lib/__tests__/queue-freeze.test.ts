/**
 * OPE-247 — the pure frozen/slow-drain decision. Mirrors integration-silence.test.
 */
import { describe, it, expect } from "vitest";
import {
  assessQueueFreeze,
  assessAllQueueFreeze,
  assessQueueFreeze,
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

/**
 * OPE-497 — the gates are now overridable from `tunable_thresholds`.
 *
 * They governed a live alert while existing only as code constants, so nobody
 * inspecting the database could see what the alert tested. That opacity is part
 * of why OPE-497 was filed against a detector that was, in fact, working.
 */
describe("queue-freeze thresholds are overridable (OPE-497)", () => {
  const base = {
    queueName: "promoter_enrichment",
    label: "Promoter enrichment review",
    href: "/admin/analytics#queue-drain",
    depth: 848,
    inflow7d: 80,
    inflow14d: 496,
    oldestOpenAgeHours: null,
  };

  it("uses the code defaults when no override is supplied", () => {
    // The real prod numbers on 2026-08-19: 6 closed against 496 arrived over
    // 14d = 0.012, far under the 0.5 gate. This is the RED the ticket believed
    // had never fired.
    const red = assessQueueFreeze({ ...base, outflow7d: 6, outflow14d: 6 }, new Date());
    expect(red).not.toBeNull();
    expect(red!.title).toMatch(/drain ratio 0\.01 over 14d/);
    expect(red!.refKey).toBe("queue-freeze:promoter_enrichment");
  });

  it("a LOWER ratio override can quiet a lane that legitimately batches reviews", () => {
    const flow = { ...base, outflow7d: 6, outflow14d: 6 };
    expect(assessQueueFreeze(flow, new Date(), { slowDrainRatio: 0.001 })).toBeNull();
  });

  it("a LONGER frozen window can quiet a lane that drains weekly", () => {
    const frozen = { ...base, outflow7d: 0, outflow14d: 0 };
    // Default: 7 days of zero outflow is RED.
    expect(assessQueueFreeze(frozen, new Date())).not.toBeNull();
    // The override changes the WORDING as well as the gate, so the digest never
    // quotes a threshold that is not the one in force.
    const red = assessQueueFreeze(frozen, new Date(), { frozenZeroOutflowDays: 30 });
    expect(red!.title).toMatch(/0 closed in 30d \(frozen\)/);
  });

  it("still refuses to fire on a null outflow, whatever the thresholds say", () => {
    // The entity-level promoter queue is exactly this shape: 485 deep, and no
    // computable outflow until OPE-496 makes last_enriched_at reliable.
    const unknown = { ...base, depth: 485, outflow7d: null, outflow14d: null };
    expect(assessQueueFreeze(unknown, new Date(), { slowDrainRatio: 0.99 })).toBeNull();
  });
});
