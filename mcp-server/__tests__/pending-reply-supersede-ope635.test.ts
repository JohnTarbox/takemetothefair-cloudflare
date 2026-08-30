/**
 * OPE-635 — the exit `approved` never had.
 *
 * Two defects, one seam. A reply approved 2026-08-17 sat undelivered for 13
 * days because NOTHING DRAINS this queue while the tool said "approved drafts
 * go out when the flag is enabled"; and once it had been delivered by hand,
 * the queued copy could not be closed out, because settled drafts were not
 * re-reviewable at all. Closing it required a raw D1 UPDATE around the state
 * machine.
 *
 * The tests that matter here are the REFUSALS. A `superseded` row is a claim
 * that a customer already received this text — if that claim can be made on an
 * operator's say-so, the status is worth nothing and a future drain will trust
 * it anyway.
 */
import { describe, it, expect } from "vitest";
import {
  allowedFromStatuses,
  resolveDischargingSend,
  type LedgerSend,
} from "../src/tools/admin-pending-replies.js";

describe("allowedFromStatuses — re-review only toward closure", () => {
  it("keeps approve and discard pending-only", () => {
    // Unchanged behaviour: re-reviewing a settled draft would overwrite the
    // original decision and its timestamp.
    expect(allowedFromStatuses("approve")).toEqual(["pending"]);
    expect(allowedFromStatuses("discard")).toEqual(["pending"]);
  });

  it("lets supersede reach an APPROVED row — the trap this ticket exists for", () => {
    expect(allowedFromStatuses("supersede")).toContain("approved");
  });

  it("never lets any action touch an already-terminal row", () => {
    // sent / discarded / superseded are settled. Allowing a transition out of
    // them would let a closed row be reopened toward sending, which is the one
    // direction this must never move.
    for (const action of ["approve", "discard", "supersede"] as const) {
      const allowed = allowedFromStatuses(action);
      expect(allowed).not.toContain("sent");
      expect(allowed).not.toContain("discarded");
      expect(allowed).not.toContain("superseded");
    }
  });
});

describe("resolveDischargingSend — delivered-elsewhere must be provable", () => {
  const sends: LedgerSend[] = [
    { messageId: "73a7d935d6496cc5c40209632f0f4c82" }, // newest first
    { messageId: "older-send-id" },
  ];

  it("REFUSES when the ledger shows no send for the inbound", () => {
    // The load-bearing case. Without this, `supersede` is just a second word
    // for `discard` that additionally tells a future drain "already handled" —
    // so a customer who never received a reply would be recorded as answered.
    expect(resolveDischargingSend([])).toEqual({ ok: false, error: "no_matching_send" });
  });

  it("REFUSES a message_id that is not in the ledger for this inbound", () => {
    expect(resolveDischargingSend(sends, "some-other-message")).toEqual({
      ok: false,
      error: "message_id_not_in_ledger",
    });
  });

  it("accepts a message_id the ledger confirms", () => {
    expect(resolveDischargingSend(sends, "older-send-id")).toEqual({
      ok: true,
      messageId: "older-send-id",
    });
  });

  it("falls back to the most recent send when none is named", () => {
    // Callers rarely have the id to hand; the newest matching send is the
    // sensible default, and it is still a REAL send rather than an assertion.
    expect(resolveDischargingSend(sends)).toEqual({
      ok: true,
      messageId: "73a7d935d6496cc5c40209632f0f4c82",
    });
  });

  it("never returns ok without a message id", () => {
    // The whole point of the column: a superseded row must carry the message
    // that discharged it. `sent_message_id` existed from the start and no path
    // ever wrote it.
    for (const input of [[], sends] as LedgerSend[][]) {
      for (const req of [undefined, "nope", "older-send-id"]) {
        const r = resolveDischargingSend(input, req);
        if (r.ok) expect(r.messageId).toBeTruthy();
      }
    }
  });
});
