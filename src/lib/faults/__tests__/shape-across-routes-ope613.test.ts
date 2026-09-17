/**
 * OPE-613 rework — one render-fault SHAPE is one fault, whichever page it hit.
 *
 * The 2026-09-07 scan: `(evaluating *.id)` fired 29 times on 17 pathnames and
 * produced 9 ledger rows carrying 13 of the 29; the other 16 never cleared a
 * per-route gate. And on 09-06 `/events/sterling-fair/2026` minted an unfiled
 * `proposed` row four minutes after `/events/massachusetts` — same shape, same
 * browser — had already been filed to OPE-613.
 *
 * The signature stays `route#class` (a ruling on one shape must not silence a
 * different shape on the same page — the original OPE-613 defect). These pin
 * what now reads the SHAPE, each beside the case it must NOT touch.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reconcileFaults, shapeKey, type FaultLedgerRow, type GroupedFault } from "../reconcile";

const NOW = new Date("2026-09-16T12:00:00Z");
const HOUR = 3_600_000;
const ID = "typeerror: null is not an object (evaluating *.id)";
const PARENT = "typeerror: null is not an object (evaluating *.parentnode)";

function group(route: string, errorClass: string, over: Partial<GroupedFault> = {}): GroupedFault {
  return {
    signature: `${route}#${errorClass}`,
    route,
    errorClass,
    count: 1,
    distinctSessions: 1,
    firstSeen: NOW.getTime() - 5 * HOUR,
    lastSeen: NOW.getTime() - HOUR,
    ...over,
  };
}

function ledger(
  route: string,
  errorClass: string,
  status: string,
  over: Partial<FaultLedgerRow> = {}
): FaultLedgerRow {
  return {
    signature: `${route}#${errorClass}`,
    route,
    errorClass,
    firstSeen: NOW.getTime() - 200 * HOUR,
    lastSeen: NOW.getTime() - 20 * HOUR,
    count: 4,
    status: status as FaultLedgerRow["status"],
    opeId: null,
    filedAt: null,
    resolvedAt: null,
    createdAt: NOW.getTime() - 200 * HOUR,
    ...over,
  };
}

const filedMassachusetts = ledger("/events/massachusetts", ID, "filed", {
  opeId: "OPE-613",
  filedAt: NOW.getTime() - 100 * HOUR,
});

describe("a new route with a filed shape joins that ticket", () => {
  it("the sterling-fair case: linked to OPE-613, not proposed, not dropped", () => {
    const r = reconcileFaults(
      [group("/events/sterling-fair/2026", ID, { count: 2 })],
      [filedMassachusetts],
      NOW
    );
    expect(r.linked).toEqual([
      { signature: `/events/sterling-fair/2026#${ID}`, errorClass: ID, opeId: "OPE-613" },
    ]);
    expect(r.upserts).toContainEqual(
      expect.objectContaining({ op: "link", opeId: "OPE-613", count: 2 })
    );
    expect(r.toEmit).toEqual([]);
    expect(r.subThreshold).toEqual([]);
  });

  it("an already-proposed unfiled sibling row is linked, not handed out as backlog", () => {
    const stuck = ledger("/events/sterling-fair/2026", ID, "proposed");
    const r = reconcileFaults([], [filedMassachusetts, stuck], NOW);
    expect(r.backlog).toEqual([]);
    expect(r.linked.map((l) => l.signature)).toEqual([stuck.signature]);
  });

  it("a DIFFERENT shape on the same route is not linked — the original OPE-613 defect stays fixed", () => {
    const r = reconcileFaults(
      [group("/events/massachusetts", PARENT, { count: 5, distinctSessions: 3 })],
      [filedMassachusetts],
      NOW
    );
    expect(r.linked).toEqual([]);
    expect(r.toEmit.map((c) => c.errorClass)).toEqual([PARENT]);
  });

  it("a settled sibling (done / noise / resolved) is not a live ticket to join", () => {
    for (const status of ["done", "noise", "resolved"]) {
      const settled = ledger("/events/massachusetts", ID, status, {
        opeId: "OPE-1",
        filedAt: NOW.getTime() - 100 * HOUR,
        resolvedAt: NOW.getTime() - 90 * HOUR,
      });
      const r = reconcileFaults(
        [group("/events/sterling-fair/2026", ID, { count: 5, distinctSessions: 3 })],
        [settled],
        NOW
      );
      expect(r.linked, status).toEqual([]);
      expect(
        r.toEmit.map((c) => c.route),
        status
      ).toEqual(["/events/sterling-fair/2026"]);
    }
  });

  it("server-lane rows never link across sources — two jobs hitting D1_ERROR are two faults", () => {
    const cls = "d1_error: too many sql variables";
    const filed = ledger("api/vendor/self-reported-events", cls, "filed", { opeId: "OPE-9" });
    const r = reconcileFaults(
      [group("app/events/page.tsx:getEvents", cls, { count: 5, distinctSessions: 3 })],
      [filed],
      NOW
    );
    expect(r.linked).toEqual([]);
    expect(r.toEmit).toHaveLength(1);
  });

  it("an opaque `script error.` never links — it carries no evidence of which fault it is", () => {
    const filed = ledger("/register", "script error.", "filed", { opeId: "OPE-173" });
    const r = reconcileFaults(
      [group("/login", "script error.", { count: 5, distinctSessions: 3 })],
      [filed],
      NOW
    );
    expect(r.linked).toEqual([]);
    expect(shapeKey("/login", "script error.")).toBeNull();
  });
});

describe("a shape spread thin across routes is detected, once", () => {
  const routes = ["/events/a", "/events/b", "/blog/c", "/venues/d", "/for-vendors"];

  it("five routes at one occurrence each: ONE candidate, four held — none silently sub-threshold", () => {
    const r = reconcileFaults(
      routes.map((route) => group(route, ID)),
      [],
      NOW
    );
    expect(r.subThreshold).toEqual([]);
    expect(r.toEmit).toHaveLength(1);
    expect(r.heldForSibling).toHaveLength(4);
    expect(new Set(r.heldForSibling.map((h) => h.representative))).toEqual(
      new Set([r.toEmit[0].signature])
    );
    // Every route is still recorded in the ledger, so the next run can link it.
    expect(r.upserts.filter((u) => u.op === "propose")).toHaveLength(5);
  });

  it("control: a single route at one occurrence is still sub-threshold", () => {
    const r = reconcileFaults([group("/events/a", ID)], [], NOW);
    expect(r.toEmit).toEqual([]);
    expect(r.subThreshold).toHaveLength(1);
  });

  it("the next run, after the representative is filed, links the rest", () => {
    const first = reconcileFaults(
      routes.map((route) => group(route, ID)),
      [],
      NOW
    );
    const repSig = first.toEmit[0].signature;
    const ledgerAfter = routes.map((route) => {
      const sig = `${route}#${ID}`;
      return ledger(route, ID, sig === repSig ? "filed" : "proposed", {
        opeId: sig === repSig ? "OPE-2000" : null,
        filedAt: sig === repSig ? NOW.getTime() : null,
      });
    });
    const second = reconcileFaults(
      routes.map((route) => group(route, ID)),
      ledgerAfter,
      new Date(NOW.getTime() + HOUR)
    );
    expect(second.toEmit).toEqual([]);
    expect(second.backlog).toEqual([]);
    expect(second.linked.map((l) => l.opeId)).toEqual(Array(4).fill("OPE-2000"));
  });

  it("an unfiled backlog is handed out one row per shape", () => {
    const stuck = routes.map((route, i) =>
      ledger(route, ID, "proposed", { firstSeen: NOW.getTime() - (100 - i) * HOUR })
    );
    const r = reconcileFaults([], stuck, NOW);
    expect(r.backlog.map((b) => b.route)).toEqual(["/events/a"]); // oldest represents
    expect(r.heldForSibling).toHaveLength(4);
  });
});

describe("the route applies a link", () => {
  const src = readFileSync(
    join(__dirname, "../../../app/api/internal/faults/candidates/route.ts"),
    "utf8"
  );
  it("writes status filed with the sibling's ope_id", () => {
    const at = src.indexOf('up.op === "link"');
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 1500);
    expect(block).toMatch(/status: "filed",\s*opeId: up\.opeId/);
    expect(block).toMatch(/set: \{ status: "filed", opeId: up\.opeId, filedAt: now \}/);
  });
});
