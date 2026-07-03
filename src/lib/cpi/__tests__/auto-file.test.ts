import { describe, expect, it } from "vitest";
import type { ActionQueueEntry } from "@/lib/analytics-overview/types";
import {
  DEFAULT_RATE_CAP_PER_RUN,
  fingerprintFor,
  isFileable,
  reconcileFilings,
  routeAgentCode,
  type LedgerRow,
} from "@/lib/cpi/auto-file";

const NOW = new Date("2026-07-03T12:00:00.000Z");

/** Build an ActionQueueEntry first detected `hoursAgo` before NOW. */
function entry(
  priority: "P0" | "P1",
  hoursAgo: number | null,
  overrides: Partial<ActionQueueEntry> = {}
): ActionQueueEntry {
  const firstDetectedAt =
    hoursAgo === null ? null : new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
  return {
    priority,
    source: "kpi",
    title: `${priority} signal`,
    effort: "Investigate",
    href: "/admin/analytics",
    firstDetectedAt,
    refKey: overrides.refKey ?? `${priority}-${hoursAgo}`,
    // OPE-78 fields (present on main after the merge). auto-file derives
    // fileability from firstDetectedAt, so these carry no logic weight here.
    hoursInRed: hoursAgo,
    slaStatus: "none",
    ...overrides,
  };
}

/** Build a ledger row for a given fingerprint + status. */
function ledgerRow(
  fingerprint: string,
  status: LedgerRow["status"],
  over: Partial<LedgerRow> = {}
): LedgerRow {
  return {
    fingerprint,
    priority: "P0",
    title: "old title",
    href: "/admin/analytics",
    firstDetectedAt: NOW.getTime() - 100 * 3_600_000,
    lastSeenAt: NOW.getTime() - 86_400_000,
    status,
    opeId: null,
    filedAt: null,
    resolvedAt: null,
    createdAt: NOW.getTime() - 200 * 3_600_000,
    ...over,
  };
}

describe("fingerprintFor", () => {
  it("is `cpi:<source>:<refKey>` and stable across scans", () => {
    expect(fingerprintFor({ source: "kpi", refKey: "search_visibility" })).toBe(
      "cpi:kpi:search_visibility"
    );
    expect(fingerprintFor({ source: "recommendation", refKey: "activate_x" })).toBe(
      "cpi:recommendation:activate_x"
    );
  });
});

describe("isFileable", () => {
  it("P0 is always fileable (even with no age)", () => {
    expect(isFileable(entry("P0", null), NOW)).toBe(true);
    expect(isFileable(entry("P0", 1), NOW)).toBe(true);
  });

  it("P1 fileable only once aged past the Move-1 72h threshold", () => {
    expect(isFileable(entry("P1", 80), NOW)).toBe(true);
    expect(isFileable(entry("P1", 72), NOW)).toBe(false); // strictly greater than
    expect(isFileable(entry("P1", 50), NOW)).toBe(false);
    expect(isFileable(entry("P1", null), NOW)).toBe(false); // no age → not red
  });
});

describe("routeAgentCode", () => {
  it("routes kpi → developer, recommendation → analyst", () => {
    expect(routeAgentCode({ source: "kpi" })).toBe("developer-claude-code");
    expect(routeAgentCode({ source: "recommendation" })).toBe("analyst-claude-desktop");
  });
});

describe("reconcileFilings", () => {
  it("a new signal with no ledger row → toFile (status becomes proposed)", () => {
    const r = reconcileFilings([entry("P0", 5, { refKey: "a" })], [], NOW);
    expect(r.toFile.map((s) => s.fingerprint)).toEqual(["cpi:kpi:a"]);
    expect(r.existing).toHaveLength(0);
    expect(r.deferred).toHaveLength(0);
    const propose = r.upserts.find((u) => u.op === "propose");
    expect(propose?.fingerprint).toBe("cpi:kpi:a");
    // Carries the routing bracket the agent uses.
    expect(r.toFile[0].agentCode).toBe("developer-claude-code");
  });

  it("an already-filed signal → existing (NOT re-filed) — the dedup acceptance", () => {
    const row = ledgerRow("cpi:kpi:a", "filed", { opeId: "OPE-999" });
    const r = reconcileFilings([entry("P0", 5, { refKey: "a" })], [row], NOW);
    expect(r.toFile).toHaveLength(0);
    expect(r.existing.map((s) => s.fingerprint)).toEqual(["cpi:kpi:a"]);
    expect(r.existing[0].opeId).toBe("OPE-999");
    // last_seen bumped via a touch, not a re-propose.
    expect(r.upserts.some((u) => u.op === "touch" && u.fingerprint === "cpi:kpi:a")).toBe(true);
    expect(r.upserts.some((u) => u.op === "propose")).toBe(false);
  });

  it("a proposed (not yet filed) signal still present → existing, not re-filed", () => {
    const row = ledgerRow("cpi:kpi:a", "proposed");
    const r = reconcileFilings([entry("P0", 5, { refKey: "a" })], [row], NOW);
    expect(r.toFile).toHaveLength(0);
    expect(r.existing.map((s) => s.fingerprint)).toEqual(["cpi:kpi:a"]);
  });

  it("a signal missing from the fileable set → resolved", () => {
    const row = ledgerRow("cpi:kpi:gone", "filed", { opeId: "OPE-1" });
    const r = reconcileFilings([], [row], NOW);
    expect(r.resolved.map((x) => x.fingerprint)).toEqual(["cpi:kpi:gone"]);
    const resolve = r.upserts.find((u) => u.op === "resolve");
    expect(resolve?.fingerprint).toBe("cpi:kpi:gone");
  });

  it("an already-resolved row absent from the set is NOT re-resolved", () => {
    const row = ledgerRow("cpi:kpi:done", "resolved");
    const r = reconcileFilings([], [row], NOW);
    expect(r.resolved).toHaveLength(0);
    expect(r.upserts).toHaveLength(0);
  });

  it("a re-appeared resolved fingerprint → treated as a NEW incident (toFile)", () => {
    const row = ledgerRow("cpi:kpi:a", "resolved", { resolvedAt: NOW.getTime() - 3_600_000 });
    const r = reconcileFilings([entry("P0", 2, { refKey: "a" })], [row], NOW);
    expect(r.toFile.map((s) => s.fingerprint)).toEqual(["cpi:kpi:a"]);
    // Re-proposed so the agent files it again and the reopen clears prior state.
    expect(r.upserts.some((u) => u.op === "propose" && u.fingerprint === "cpi:kpi:a")).toBe(true);
  });

  it("more new signals than the rate cap → the overflow is deferred (still proposed)", () => {
    const entries = Array.from({ length: DEFAULT_RATE_CAP_PER_RUN + 2 }, (_, i) =>
      entry("P0", i + 1, { refKey: `k${i}` })
    );
    const r = reconcileFilings(entries, [], NOW, { rateCapPerRun: DEFAULT_RATE_CAP_PER_RUN });
    expect(r.toFile).toHaveLength(DEFAULT_RATE_CAP_PER_RUN);
    expect(r.deferred).toHaveLength(2);
    // Every new candidate (filed + deferred) is upserted as 'proposed'.
    const proposeCount = r.upserts.filter((u) => u.op === "propose").length;
    expect(proposeCount).toBe(DEFAULT_RATE_CAP_PER_RUN + 2);
  });

  it("rate cap files the most-aged P0s first; younger overflow defers", () => {
    const entries = [entry("P0", 10, { refKey: "young" }), entry("P0", 100, { refKey: "old" })];
    const r = reconcileFilings(entries, [], NOW, { rateCapPerRun: 1 });
    expect(r.toFile.map((s) => s.fingerprint)).toEqual(["cpi:kpi:old"]);
    expect(r.deferred.map((s) => s.fingerprint)).toEqual(["cpi:kpi:young"]);
  });

  it("never throws on an unparseable firstDetectedAt", () => {
    const bad = entry("P0", 5, { refKey: "a", firstDetectedAt: "not-a-date" });
    expect(() => reconcileFilings([bad], [], NOW)).not.toThrow();
    const r = reconcileFilings([bad], [], NOW);
    expect(r.toFile[0].hoursInRed).toBeNull();
  });
});
