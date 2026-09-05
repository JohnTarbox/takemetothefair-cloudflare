/**
 * OPE-811 — a signature that is minted and never filed must not be invisible.
 *
 * Production, 2026-09-05: 19 `proposed` rows, none carrying an `ope_id`, the
 * oldest 15 days old, while the weekly rail run on 09-01 finished
 * `ROUTINE_RUN_STATUS_SUCCEEDED`. The rail was not lying — it asked "did my
 * query return anything?", got no, and said so. The question was wrong.
 *
 * The mechanism is narrower than the ticket states, and worth naming exactly:
 * `reconcileFaults` bucketed every `proposed`/`filed`/`regressed` row into
 * `existing`, documented as *"already known / flagged"* and *"NEVER
 * re-emitted"*, and the rail ignores `existing` by design. A `proposed` row
 * with no `ope_id` is **known but not flagged**. Once minted it could never be
 * filed: not new, so never in `toEmit`; in `existing`, so never looked at.
 *
 * Same shape as OPE-804 and OPE-803 — two materially different facts sharing
 * one value, and the losing case looks exactly like the benign one.
 */
import { describe, expect, it } from "vitest";
import { reconcileFaults, type FaultLedgerRow, type GroupedFault } from "@/lib/faults/reconcile";
import {
  buildRailHealth,
  isFileableStatus,
  isParked,
  isUnknownStatus,
  unfiledCandidateCount,
} from "@/lib/faults/status";

const NOW = new Date("2026-09-05T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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

function ledgerRow(
  signature: string,
  status: string,
  over: Partial<FaultLedgerRow> = {}
): FaultLedgerRow {
  return {
    signature,
    route: "/events/[slug]",
    errorClass: "boom",
    firstSeen: NOW.getTime() - 15 * DAY,
    lastSeen: NOW.getTime() - 2 * DAY,
    count: 12,
    status: status as FaultLedgerRow["status"],
    opeId: null,
    filedAt: null,
    resolvedAt: null,
    createdAt: NOW.getTime() - 15 * DAY,
    ...over,
  };
}

describe("the stuck population drains", () => {
  it("an unfiled `proposed` row that no longer recurs still becomes fileable", () => {
    // The exact production shape: minted 15 days ago, never filed, and absent
    // from today's scan window. A backlog derived from the scan groups would
    // miss precisely the rows that have been stuck longest.
    const r = reconcileFaults([], [ledgerRow("stuck", "proposed")], NOW);

    expect(r.backlog).toHaveLength(1);
    expect(r.backlog[0].signature).toBe("stuck");
    expect(r.backlog[0].kind).toBe("backlog");
    // And it is NOT reported as new — filing a 15-day-old stuck row and
    // finding a fault this morning are different events.
    expect(r.toEmit).toHaveLength(0);
  });

  it("an `open` row with no ope_id drains too — that is the vocabulary half", () => {
    // 8 production rows use `open`, the status the rail's Procedure A queries.
    // All 8 happen to carry an ope_id today, but the code must not depend on
    // that: an unfiled `open` row is fileable.
    const r = reconcileFaults([], [ledgerRow("agent-open", "open")], NOW);
    expect(r.backlog.map((c) => c.signature)).toEqual(["agent-open"]);
  });

  it("a row that IS filed stays ignored — this is the half that must not regress", () => {
    const r = reconcileFaults([], [ledgerRow("filed", "proposed", { opeId: "OPE-123" })], NOW);
    expect(r.backlog).toHaveLength(0);
  });

  it("terminal dispositions are never resurrected", () => {
    // 35 `noise` rows, 34 of them unfiled. Resurfacing those would re-open
    // 34 adjudications somebody already made — the gate-noise lesson.
    const r = reconcileFaults(
      [],
      [ledgerRow("n", "noise"), ledgerRow("r", "resolved"), ledgerRow("d", "done")],
      NOW
    );
    expect(r.backlog).toHaveLength(0);
  });

  it("`watch` is parked, not backlog — unfiled BY DESIGN", () => {
    const r = reconcileFaults([], [ledgerRow("w", "watch")], NOW);
    expect(r.backlog).toHaveLength(0);
    expect(isParked("watch")).toBe(true);
    expect(isFileableStatus("watch")).toBe(false);
  });

  it("an UNKNOWN status counts as fileable, never as handled", () => {
    // The defect in miniature: `r.status as FaultStatus` is an unchecked cast,
    // and an unrecognised value used to fall into the ignore bucket.
    const r = reconcileFaults([], [ledgerRow("mystery", "some-future-status")], NOW);
    expect(isUnknownStatus("some-future-status")).toBe(true);
    expect(r.backlog.map((c) => c.signature)).toEqual(["mystery"]);
  });

  it("drains OLDEST first and respects the batch cap — no second budget", () => {
    // 19 stuck rows must not become 19 OPEs in one run. They share the flap
    // guard with new candidates.
    const rows = Array.from({ length: 19 }, (_, i) =>
      ledgerRow(`s${String(i).padStart(2, "0")}`, "proposed", {
        firstSeen: NOW.getTime() - (19 - i) * DAY,
      })
    );
    const r = reconcileFaults([], rows, NOW);
    expect(r.backlog).toHaveLength(5); // DEFAULT_BATCH_CAP
    // Oldest first: a backlog drained newest-first never reaches its tail.
    expect(r.backlog.map((c) => c.signature)).toEqual(["s00", "s01", "s02", "s03", "s04"]);
    expect(r.deferred).toHaveLength(14);
  });

  it("a NEW candidate this run takes cap priority over the backlog", () => {
    // Fresh breakage outranks a 15-day-old stuck row; the backlog takes what
    // is left of the same cap rather than getting its own.
    const rows = Array.from({ length: 10 }, (_, i) => ledgerRow(`old${i}`, "proposed"));
    const r = reconcileFaults([group("brand-new")], rows, NOW);
    expect(r.toEmit).toHaveLength(1);
    expect(r.backlog).toHaveLength(4);
    expect(r.toEmit.length + r.backlog.length).toBe(5);
  });

  it("a signature emitted this run is not ALSO in the backlog", () => {
    const r = reconcileFaults([group("dup")], [ledgerRow("dup", "done", { resolvedAt: 1 })], NOW);
    const emitted = [...r.toEmit, ...r.regressions].map((c) => c.signature);
    expect(emitted).toContain("dup");
    expect(r.backlog.map((c) => c.signature)).not.toContain("dup");
  });
});

describe("the run can no longer report success while starved", () => {
  const empty = { toEmit: [], backlog: [], regressions: [] };

  it("files nothing while fileable work exists → UNHEALTHY", () => {
    const h = buildRailHealth([{ status: "proposed", opeId: null }], empty);
    expect(h.healthy).toBe(false);
    expect(h.unfiledCandidates).toBe(1);
    expect(h.reason).toContain("OPE-811");
  });

  it("files nothing with nothing to file → healthy (the honest quiet week)", () => {
    // Positive landmark. Without this the assertion above is satisfied by a
    // health check that simply always says unhealthy.
    const h = buildRailHealth([{ status: "proposed", opeId: "OPE-1" }], empty);
    expect(h.healthy).toBe(true);
    expect(h.unfiledCandidates).toBe(0);
    expect(h.reason).toBe("");
  });

  it("files something → healthy regardless of remaining backlog", () => {
    const h = buildRailHealth([{ status: "proposed", opeId: null }], {
      toEmit: [1],
      backlog: [],
      regressions: [],
    });
    expect(h.healthy).toBe(true);
  });

  it("⚠️ `watch` rows do NOT make the rail permanently unhealthy", () => {
    // The ticket proposed asserting on `status NOT IN ('noise','done')`. That
    // counts the two production `watch` rows — unfiled by design — so the
    // assertion would have shipped already failing, and an alarm that is
    // always on is an alarm nobody reads. This is why the predicate is scoped
    // to fileable statuses instead.
    const h = buildRailHealth(
      [
        { status: "watch", opeId: null },
        { status: "watch", opeId: null },
      ],
      empty
    );
    expect(h.healthy).toBe(true);
    expect(h.parked).toBe(2);
    expect(h.unfiledCandidates).toBe(0);
  });

  it("reproduces the 2026-09-01 run that reported SUCCEEDED", () => {
    // The whole production ledger, by status, as measured.
    const ledger = [
      ...Array.from({ length: 35 }, () => ({ status: "noise", opeId: null })),
      ...Array.from({ length: 19 }, () => ({ status: "proposed", opeId: null })),
      ...Array.from({ length: 8 }, () => ({ status: "open", opeId: "OPE-x" })),
      ...Array.from({ length: 3 }, () => ({ status: "resolved", opeId: "OPE-y" })),
      ...Array.from({ length: 2 }, () => ({ status: "watch", opeId: null })),
      { status: "done", opeId: "OPE-z" },
    ];
    expect(ledger).toHaveLength(68);
    expect(unfiledCandidateCount(ledger)).toBe(19);

    const h = buildRailHealth(ledger, empty);
    expect(h.healthy).toBe(false);
    expect(h.unfiledCandidates).toBe(19);
    expect(h.parked).toBe(2);
    expect(h.unknownStatus).toBe(0);
  });
});
