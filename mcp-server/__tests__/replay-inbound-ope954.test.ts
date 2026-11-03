/**
 * OPE-954 — replay a failed submission without emailing anyone.
 *
 * John's condition (2026-10-04): replaying f8ef71e5 must NOT send Carolyn
 * another automated message. Pinned three ways: the rule every send path asks,
 * the replay tool against real SQLite (the flag is set and read back BEFORE the
 * run is created), and every send site in the workflow and the stale sweep
 * consulting the rule — the sweep's re-dispatch and give-up notice included.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { adminActions, inboundEmails } from "../src/schema.js";
import { heldSendReason } from "../src/inbound/replies-suppressed.js";
import { handleReplayInbound } from "../src/tools/admin-replay-inbound-email.js";

describe("heldSendReason — the rule every inbound send path asks", () => {
  it("a replayed row is held, and the ledger names the replay (row flag wins)", () => {
    expect(heldSendReason({ repliesSuppressedReason: "replay: OPE-954" }, true, "HELD")).toBe(
      "suppressed: replay: OPE-954"
    );
    expect(heldSendReason({ repliesSuppressedReason: "replay: x" }, false, "HELD")).toBe(
      "suppressed: replay: x"
    );
  });
  it("control: an ordinary row sends, unless the global gate holds it", () => {
    expect(heldSendReason({ repliesSuppressedReason: null }, true, "HELD")).toBeNull();
    expect(heldSendReason({}, false, "HELD")).toBe("HELD");
    expect(heldSendReason(null, true, "HELD")).toBeNull();
  });
});

let db: TestDb;
const ID = "f8ef71e5-3ee4-4fc5-b6fa-1e58b18e7705";

function seed(
  over: Partial<{ status: string; intent: string; resultingEventId: string | null }> = {}
) {
  db.insert(inboundEmails)
    .values({
      id: ID,
      receivedAt: new Date("2026-09-12T01:20:41Z"),
      createdAt: new Date("2026-09-12T01:20:41Z"),
      fromAddress: "carolyn@example.org",
      toAddress: "submit@meetmeatthefair.com",
      subject: "Fwd: our fair",
      status: over.status ?? "failed",
      intent: over.intent ?? "new_event",
      resultingEventId: over.resultingEventId ?? null,
    } as never)
    .run();
}

/** A fake binding that records what the DB said at the moment of create. */
function recordingBinding() {
  const calls: Array<{ params: unknown; flagAtCreate: string | null }> = [];
  return {
    calls,
    create: async (opts: { params: unknown }) => {
      const [r] = db
        .select({ f: inboundEmails.repliesSuppressedReason })
        .from(inboundEmails)
        .where(eq(inboundEmails.id, ID))
        .all();
      calls.push({ params: opts.params, flagAtCreate: r?.f ?? null });
      return { id: "wf-replay-1" };
    },
  };
}

describe("replay_inbound_email — the handler, against real SQLite", () => {
  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("SPECIMEN: sets the flag, READS IT BACK, and only then creates the run", async () => {
    seed();
    const b = recordingBinding();
    const r = await handleReplayInbound(
      db,
      b,
      { inboundEmailId: ID, reason: "OPE-954" },
      "u-admin"
    );
    expect(r).toMatchObject({ ok: true, workflowInstanceId: "wf-replay-1" });
    expect(b.calls).toHaveLength(1);
    // The run was created with the flag ALREADY in place.
    expect(b.calls[0].flagAtCreate).toBe("replay: OPE-954");
    expect(b.calls[0].params).toEqual({ messageRowId: ID, intent: "new_event" });
    const audit = db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, "inbound.replayed"))
      .all();
    expect(audit).toHaveLength(1);
    expect(audit[0].targetId).toBe(ID);
  });

  it.each([
    [{ status: "replied" }, "answered_needs_opt_in"],
    [{ status: "processing" }, "status_not_replayable"],
    [{ intent: "support" }, "intent_not_replayable"],
  ])("refuses %o and creates no run", async (over, reason) => {
    seed(over);
    const b = recordingBinding();
    const r = await handleReplayInbound(db, b, { inboundEmailId: ID, reason: "x" }, null);
    expect(r).toMatchObject({ ok: false, reason });
    expect(b.calls).toHaveLength(0);
  });

  // OPE-405 (John, 2026-10-04) — the one opt-in: an already-answered row, to
  // re-run roster capture on 9fc287ef. Only WITH the flag and WITH an anchor.
  it("OPE-405: a replied row with allow_answered AND a resulting event replays, flag first", async () => {
    seed({ status: "replied", resultingEventId: "4fde2cf7-9298-4b8d-b32f-36b79c376ad0" });
    const b = recordingBinding();
    const r = await handleReplayInbound(
      db,
      b,
      { inboundEmailId: ID, reason: "OPE-405", allowAnswered: true },
      "u-admin"
    );
    expect(r).toMatchObject({
      ok: true,
      existingEventId: "4fde2cf7-9298-4b8d-b32f-36b79c376ad0",
    });
    expect(b.calls[0].flagAtCreate).toBe("replay: OPE-405");
    const [audit] = db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, "inbound.replayed"))
      .all();
    expect(JSON.parse(audit.payloadJson!)).toMatchObject({
      allowAnswered: true,
      existingEventId: "4fde2cf7-9298-4b8d-b32f-36b79c376ad0",
    });
  });

  it("OPE-405: a replied row WITHOUT an event is refused even with the opt-in (no dedup anchor)", async () => {
    seed({ status: "replied", resultingEventId: null });
    const b = recordingBinding();
    const r = await handleReplayInbound(
      db,
      b,
      { inboundEmailId: ID, reason: "x", allowAnswered: true },
      null
    );
    expect(r).toMatchObject({ ok: false, reason: "answered_without_event" });
    expect(b.calls).toHaveLength(0);
  });

  it("OPE-405: the opt-in does not open any OTHER status", async () => {
    seed({ status: "processing", resultingEventId: "e1" });
    const b = recordingBinding();
    const r = await handleReplayInbound(
      db,
      b,
      { inboundEmailId: ID, reason: "x", allowAnswered: true },
      null
    );
    expect(r).toMatchObject({ ok: false, reason: "status_not_replayable" });
    expect(b.calls).toHaveLength(0);
  });

  it("a missing row or binding creates no run", async () => {
    const b = recordingBinding();
    expect(
      await handleReplayInbound(db, b, { inboundEmailId: "nope", reason: "x" }, null)
    ).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    seed();
    expect(
      await handleReplayInbound(db, undefined, { inboundEmailId: ID, reason: "x" }, null)
    ).toMatchObject({
      ok: false,
      reason: "no_binding",
    });
    expect(b.calls).toHaveLength(0);
  });
});

describe("every send site that can email about an inbound row asks heldSendReason", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  // Positive landmark: the send sites this guard covers, counted, so a new one
  // added without the gate fails here instead of passing over it.
  const SITES: Array<[string, RegExp, number]> = [
    ["src/workflows/inbound-email.ts", /env\.EMAIL\.send\(|env\.EMAIL_JOBS\.send\(/g, 3],
    ["src/inbound-email-stale-sweep.ts", /env\.EMAIL\.send\(/g, 1],
  ];
  it.each(SITES)("%s: %d send site(s), each preceded by a heldSendReason gate", (file, re, n) => {
    const s = src(file);
    const sends = [...s.matchAll(re)].map((m) => m.index ?? 0);
    expect(sends).toHaveLength(n);
    for (const at of sends) {
      // The gate sits in the same step, before the send.
      const window = s.slice(Math.max(0, at - 2600), at);
      expect(window, `send at offset ${at} has no gate before it`).toContain("heldSendReason(");
    }
  });
});
