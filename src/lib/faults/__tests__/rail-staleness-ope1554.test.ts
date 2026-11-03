/**
 * OPE-1554 — regression of OPE-811. Two controls that read green on the defect.
 *
 * 1. `buildRailHealth` fired only when a run emitted NOTHING. The emitter
 *    re-offers up to the batch cap of backlog rows every hour whether or not
 *    anyone files them, so it read healthy for 30 days while 103 rows sat
 *    unfiled (the retro rail queried `status='open'`, which matches none).
 * 2. `reconcileFaults` regressed only `done`, so a recurrence of an
 *    agent-`resolved` fault (OPE-173's /register Turnstile throw) was never seen.
 */
import { describe, expect, it } from "vitest";
import { reconcileFaults, type FaultLedgerRow, type GroupedFault } from "@/lib/faults/reconcile";
import { buildRailHealth, STALE_UNFILED_DAYS } from "@/lib/faults/status";

const NOW = new Date("2026-11-01T13:00:00.000Z");
const DAY = 86_400_000;
const nowMs = NOW.getTime();
const offered = { toEmit: [], backlog: [1, 2, 3, 4, 5], regressions: [] };

describe("rail health — offered is not filed", () => {
  it("ACCEPTANCE: a backlog offered every run but never filed for >7d is UNHEALTHY", () => {
    const h = buildRailHealth(
      [
        { status: "proposed", opeId: null, firstSeen: nowMs - 30 * DAY },
        { status: "open", opeId: null, firstSeen: nowMs - 9 * DAY },
      ],
      offered,
      { nowMs }
    );
    // The OPE-811 check alone would say healthy here: 5 rows were emitted.
    expect(h.emittingNow).toBe(5);
    expect(h.healthy).toBe(false);
    expect(h.staleUnfiled).toBe(2);
    expect(h.oldestUnfiledDays).toBe(30);
    expect(h.reason).toContain("OPE-1554");
    expect(h.reason).toContain("2 fileable");
  });

  it("LANDMARK: a fresh unfiled row (inside one weekly cycle) is still healthy", () => {
    const h = buildRailHealth(
      [{ status: "proposed", opeId: null, firstSeen: nowMs - (STALE_UNFILED_DAYS - 1) * DAY }],
      offered,
      { nowMs }
    );
    expect(h.healthy).toBe(true);
    expect(h.staleUnfiled).toBe(0);
    expect(h.reason).toBe("");
  });

  it("old rows that WERE filed, parked or ruled are not stale", () => {
    const old = nowMs - 60 * DAY;
    const h = buildRailHealth(
      [
        { status: "proposed", opeId: "OPE-1", firstSeen: old },
        { status: "watch", opeId: null, firstSeen: old },
        { status: "noise", opeId: null, firstSeen: old },
        { status: "resolved", opeId: "OPE-2", firstSeen: old },
      ],
      offered,
      { nowMs }
    );
    expect(h.healthy).toBe(true);
    expect(h.staleUnfiled).toBe(0);
    expect(h.parked).toBe(1);
  });

  it("an UNKNOWN status ages like a fileable one (never read as handled)", () => {
    const h = buildRailHealth(
      [{ status: "triaged", opeId: null, firstSeen: nowMs - 20 * DAY }],
      offered,
      { nowMs }
    );
    expect(h.staleUnfiled).toBe(1);
    expect(h.healthy).toBe(false);
  });
});

function group(signature: string, lastSeen: number): GroupedFault {
  return {
    signature,
    route: "/register",
    errorClass: signature.split("#")[1],
    count: 4,
    distinctSessions: 3,
    firstSeen: lastSeen - DAY,
    lastSeen,
  };
}

function row(signature: string, status: string, resolvedAt: number): FaultLedgerRow {
  return {
    signature,
    route: "/register",
    errorClass: signature.split("#")[1],
    firstSeen: nowMs - 120 * DAY,
    lastSeen: nowMs - 100 * DAY,
    count: 3,
    status: status as FaultLedgerRow["status"],
    opeId: "OPE-173",
    filedAt: nowMs - 115 * DAY,
    resolvedAt,
    createdAt: nowMs - 120 * DAY,
  };
}

describe("regression detection — `resolved` is `done` by another writer", () => {
  const SIG = "/register#turnstileerror: invalid value";
  const resolvedAt = nowMs - 100 * DAY;

  it.each(["done", "resolved"])("ACCEPTANCE: a recurring `%s` row becomes a regression", (st) => {
    const r = reconcileFaults([group(SIG, nowMs - DAY)], [row(SIG, st, resolvedAt)], NOW);
    expect(r.regressions.map((c) => c.signature)).toEqual([SIG]);
    expect(r.upserts).toContainEqual(expect.objectContaining({ op: "regress", signature: SIG }));
  });

  it("LANDMARK: `noise` recurring is NOT a regression (a ruling, not a fix)", () => {
    const r = reconcileFaults([group(SIG, nowMs - DAY)], [row(SIG, "noise", resolvedAt)], NOW);
    expect(r.regressions).toHaveLength(0);
  });

  it("a `resolved` row seen only BEFORE its resolution does not regress", () => {
    const r = reconcileFaults(
      [group(SIG, resolvedAt - DAY)],
      [row(SIG, "resolved", resolvedAt)],
      NOW
    );
    expect(r.regressions).toHaveLength(0);
  });
});
