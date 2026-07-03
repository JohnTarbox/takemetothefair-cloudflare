/**
 * OPE-78 — action-queue aging: SLA derivation + oldest-breach-first ordering.
 */
import { describe, it, expect } from "vitest";
import { actionQueueSla, compareActionQueueEntries } from "../action-queue-sla";
import type { ActionQueueEntry } from "../types";

const NOW = new Date("2026-07-03T00:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("actionQueueSla", () => {
  it("P0: >24h → red, >12h → amber, else green", () => {
    expect(actionQueueSla("P0", hoursAgo(25), NOW)).toMatchObject({ slaStatus: "red" });
    expect(actionQueueSla("P0", hoursAgo(15), NOW)).toMatchObject({ slaStatus: "amber" });
    expect(actionQueueSla("P0", hoursAgo(5), NOW)).toMatchObject({ slaStatus: "green" });
  });

  it("P1: >72h → red, >36h → amber, else green", () => {
    expect(actionQueueSla("P1", hoursAgo(80), NOW)).toMatchObject({ slaStatus: "red" });
    expect(actionQueueSla("P1", hoursAgo(40), NOW)).toMatchObject({ slaStatus: "amber" });
    expect(actionQueueSla("P1", hoursAgo(10), NOW)).toMatchObject({ slaStatus: "green" });
  });

  it("computes hoursInRed", () => {
    const r = actionQueueSla("P0", hoursAgo(39 * 24), NOW); // Time-to-index-style, ~39 days
    expect(r.hoursInRed).toBeCloseTo(936, 0);
    expect(r.slaStatus).toBe("red");
  });

  it("null / unparseable stamp → none, null hours", () => {
    expect(actionQueueSla("P0", null, NOW)).toEqual({ hoursInRed: null, slaStatus: "none" });
    expect(actionQueueSla("P1", "not-a-date", NOW)).toEqual({
      hoursInRed: null,
      slaStatus: "none",
    });
  });
});

function entry(p: {
  priority: "P0" | "P1";
  refKey: string;
  hoursInRed: number | null;
  source?: "kpi" | "recommendation";
}): ActionQueueEntry {
  return {
    priority: p.priority,
    source: p.source ?? "kpi",
    title: p.refKey,
    effort: "",
    href: "/x",
    firstDetectedAt: p.hoursInRed === null ? null : hoursAgo(p.hoursInRed),
    refKey: p.refKey,
    hoursInRed: p.hoursInRed,
    slaStatus: p.hoursInRed === null ? "none" : "red",
  };
}

describe("compareActionQueueEntries", () => {
  it("orders oldest-in-red first, ageless entries last", () => {
    const list = [
      entry({ priority: "P0", refKey: "fresh", hoursInRed: 2 }),
      entry({ priority: "P1", refKey: "ancient", hoursInRed: 900 }),
      entry({ priority: "P0", refKey: "ageless", hoursInRed: null, source: "recommendation" }),
      entry({ priority: "P1", refKey: "mid", hoursInRed: 100 }),
    ];
    const sorted = [...list].sort(compareActionQueueEntries).map((e) => e.refKey);
    expect(sorted).toEqual(["ancient", "mid", "fresh", "ageless"]);
  });

  it("severity breaks a tie at equal age", () => {
    const sorted = [
      entry({ priority: "P1", refKey: "p1", hoursInRed: 50 }),
      entry({ priority: "P0", refKey: "p0", hoursInRed: 50 }),
    ]
      .sort(compareActionQueueEntries)
      .map((e) => e.refKey);
    expect(sorted).toEqual(["p0", "p1"]);
  });
});
