import { describe, expect, it } from "vitest";
import {
  DEFAULT_BATCH_CAP,
  reconcileFaults,
  type FaultLedgerRow,
  type GroupedFault,
} from "@/lib/faults/reconcile";

const NOW = new Date("2026-07-03T12:00:00.000Z");
const HOUR = 3_600_000;

/** Build a grouped fault. Defaults clear the threshold gate. */
function group(signature: string, over: Partial<GroupedFault> = {}): GroupedFault {
  return {
    signature,
    route: "/events/[slug]",
    errorClass: "boom",
    count: 5,
    distinctSessions: 3,
    firstSeen: NOW.getTime() - 10 * HOUR,
    lastSeen: NOW.getTime() - HOUR,
    ...over,
  };
}

/** Build a ledger row for a given signature + status. */
function ledgerRow(
  signature: string,
  status: FaultLedgerRow["status"],
  over: Partial<FaultLedgerRow> = {}
): FaultLedgerRow {
  return {
    signature,
    route: "/events/[slug]",
    errorClass: "boom",
    firstSeen: NOW.getTime() - 100 * HOUR,
    lastSeen: NOW.getTime() - 50 * HOUR,
    count: 12,
    status,
    opeId: null,
    filedAt: null,
    resolvedAt: null,
    createdAt: NOW.getTime() - 200 * HOUR,
    ...over,
  };
}

describe("reconcileFaults", () => {
  it("(a) a high-volume signature yields exactly ONE candidate + one propose", () => {
    const r = reconcileFaults(
      [group("/x#boom", { count: 10_000, distinctSessions: 400 })],
      [],
      NOW
    );
    expect(r.toEmit.map((c) => c.signature)).toEqual(["/x#boom"]);
    expect(r.toEmit[0].kind).toBe("new");
    expect(r.toEmit[0].token).toBe("fault-sig:/x#boom");
    expect(r.toEmit[0].count).toBe(10_000);
    expect(r.upserts.filter((u) => u.op === "propose")).toHaveLength(1);
  });

  it("(b) re-running over an open (proposed/filed) signature emits nothing, just touches", () => {
    for (const status of ["proposed", "filed"] as const) {
      const row = ledgerRow("/x#boom", status, { opeId: status === "filed" ? "OPE-1" : null });
      const r = reconcileFaults([group("/x#boom")], [row], NOW);
      expect(r.toEmit).toHaveLength(0);
      expect(r.regressions).toHaveLength(0);
      expect(r.existing.map((x) => x.signature)).toEqual(["/x#boom"]);
      expect(r.upserts.some((u) => u.op === "touch" && u.signature === "/x#boom")).toBe(true);
      expect(r.upserts.some((u) => u.op === "propose")).toBe(false);
      // OPE-106: touch SETS count to the current window count (5), it does NOT
      // accumulate (row 12 + group 5 = 17). The scan re-reads a rolling window
      // every run, so accumulating would re-count the same rows into infinity.
      const touch = r.upserts.find((u) => u.op === "touch");
      expect(touch && touch.op === "touch" && touch.count).toBe(5);
    }
  });

  it("(b') OPE-106: an inflated ledger count self-heals to the window count, never accumulates", () => {
    // Simulate a row already corrupted by the old accumulate-across-runs bug
    // (count=76) whose signature now has only 4 real occurrences in the window.
    const row = ledgerRow("/x#boom", "filed", { opeId: "OPE-1", count: 76 });
    const r = reconcileFaults([group("/x#boom", { count: 4 })], [row], NOW);
    const touch = r.upserts.find((u) => u.op === "touch");
    // Faithful: count becomes 4 (the real error_logs rows), not 76 or 80.
    expect(touch && touch.op === "touch" && touch.count).toBe(4);
  });

  it("(b'') OPE-106: a regression's count is the window count, not accumulated", () => {
    const row = ledgerRow("/x#boom", "done", {
      resolvedAt: NOW.getTime() - 24 * HOUR,
      count: 50,
    });
    const r = reconcileFaults(
      [group("/x#boom", { lastSeen: NOW.getTime() - HOUR, count: 6 })],
      [row],
      NOW
    );
    expect(r.regressions[0].count).toBe(6);
    const regress = r.upserts.find((u) => u.op === "regress");
    expect(regress && regress.op === "regress" && regress.count).toBe(6);
  });

  it("(c) a signature recurring after done (lastSeen > resolvedAt) is a regression, not a dup", () => {
    const row = ledgerRow("/x#boom", "done", { resolvedAt: NOW.getTime() - 24 * HOUR });
    const r = reconcileFaults([group("/x#boom", { lastSeen: NOW.getTime() - HOUR })], [row], NOW);
    expect(r.regressions.map((c) => c.signature)).toEqual(["/x#boom"]);
    expect(r.regressions[0].kind).toBe("regression");
    expect(r.toEmit).toHaveLength(0);
    expect(r.upserts.some((u) => u.op === "regress" && u.signature === "/x#boom")).toBe(true);
  });

  it("(c') a done signature whose occurrences all predate resolvedAt just touches", () => {
    const row = ledgerRow("/x#boom", "done", { resolvedAt: NOW.getTime() - HOUR });
    // All occurrences older than the resolution → stale, not a regression.
    const r = reconcileFaults(
      [group("/x#boom", { lastSeen: NOW.getTime() - 10 * HOUR })],
      [row],
      NOW
    );
    expect(r.regressions).toHaveLength(0);
    expect(r.toEmit).toHaveLength(0);
    expect(r.upserts.some((u) => u.op === "touch")).toBe(true);
    expect(r.upserts.some((u) => u.op === "regress")).toBe(false);
  });

  it("(d) a sub-threshold one-off never emits and touches nothing", () => {
    const r = reconcileFaults([group("/x#boom", { count: 1, distinctSessions: 1 })], [], NOW);
    expect(r.toEmit).toHaveLength(0);
    expect(r.regressions).toHaveLength(0);
    expect(r.deferred).toHaveLength(0);
    expect(r.upserts).toHaveLength(0);
  });

  it("(d') a sub-threshold signature already in the ledger still touches (never drops)", () => {
    const row = ledgerRow("/x#boom", "proposed");
    const r = reconcileFaults([group("/x#boom", { count: 1, distinctSessions: 1 })], [row], NOW);
    expect(r.toEmit).toHaveLength(0);
    expect(r.existing.map((x) => x.signature)).toEqual(["/x#boom"]);
    expect(r.upserts.some((u) => u.op === "touch")).toBe(true);
  });

  it("(e) new candidates beyond the batch cap are deferred (still upserted propose)", () => {
    const groups = Array.from({ length: DEFAULT_BATCH_CAP + 2 }, (_, i) =>
      group(`/x#boom-${i}`, { count: 10 + i })
    );
    const r = reconcileFaults(groups, [], NOW);
    expect(r.toEmit).toHaveLength(DEFAULT_BATCH_CAP);
    expect(r.deferred).toHaveLength(2);
    // Every new candidate (emitted + deferred) is persisted 'proposed'.
    expect(r.upserts.filter((u) => u.op === "propose")).toHaveLength(DEFAULT_BATCH_CAP + 2);
  });

  it("(f) regressions are ordered ahead of new candidates in the cap", () => {
    const doneRow = ledgerRow("/x#regressed", "done", { resolvedAt: NOW.getTime() - 24 * HOUR });
    const r = reconcileFaults(
      [
        group("/x#new", { count: 9999 }), // huge count, but still a NEW candidate
        group("/x#regressed", { lastSeen: NOW.getTime() - HOUR, count: 1 }),
      ],
      [doneRow],
      NOW,
      { batchCap: 1 }
    );
    // The single slot goes to the regression, not the higher-count new fault.
    expect(r.regressions.map((c) => c.signature)).toEqual(["/x#regressed"]);
    expect(r.toEmit).toHaveLength(0);
    expect(r.deferred.map((c) => c.signature)).toEqual(["/x#new"]);
  });

  it("(g) never throws on unparseable / malformed input", () => {
    const garbage = [
      null,
      undefined,
      {},
      { signature: "" },
      { signature: "/x#ok", count: "lots", distinctSessions: NaN, firstSeen: null, lastSeen: {} },
    ] as unknown as GroupedFault[];
    expect(() => reconcileFaults(garbage, [], NOW)).not.toThrow();
    expect(() => reconcileFaults(garbage, null as unknown as FaultLedgerRow[], NOW)).not.toThrow();
    expect(() =>
      reconcileFaults(null as unknown as GroupedFault[], [], new Date("bad"))
    ).not.toThrow();
  });
});
