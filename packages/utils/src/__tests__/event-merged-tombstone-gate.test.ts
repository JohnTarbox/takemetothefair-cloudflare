/**
 * OPE-423 — the tombstone gate.
 *
 * These tests are written against the ACTUAL production sequence, not an
 * imagined one. The row that caused this ticket was merged cleanly on
 * 2026-06-01 and then, on 2026-06-25, taken through exactly two calls:
 *
 *   update_event_status  REJECTED → APPROVED
 *   update_event         slug renamed back to the original
 *
 * Each is pinned below as its own case. If either regresses, a merged
 * duplicate returns to the public index at its keeper's venue and dates.
 */
import { describe, it, expect } from "vitest";
import { mergedTombstoneBlockReason } from "../event-merged-tombstone-gate";

const KEEPER = "4fddcd5e-56de-4ec5-800b-143905324198";
const tombstone = { mergedInto: KEEPER };
const liveEvent = { mergedInto: null };

describe("the two calls that actually resurrected a merged event", () => {
  it("blocks REJECTED → APPROVED on a tombstone", () => {
    const reason = mergedTombstoneBlockReason(tombstone, { nextStatus: "APPROVED" });
    expect(reason).not.toBeNull();
    // The keeper's id belongs in the message: an operator who hits this needs
    // to know what it was merged into to decide whether the merge was wrong.
    expect(reason).toContain(KEEPER);
  });

  it("blocks renaming a tombstone's slug back to the free URL", () => {
    expect(mergedTombstoneBlockReason(tombstone, { slugChange: true })).not.toBeNull();
  });
});

describe("what it must NOT block", () => {
  it("leaves every non-merged event alone, whatever the intent", () => {
    // The guard is applied unconditionally at each call site, so returning
    // null for ordinary events is the property that makes that safe.
    expect(mergedTombstoneBlockReason(liveEvent, { nextStatus: "APPROVED" })).toBeNull();
    expect(mergedTombstoneBlockReason(liveEvent, { slugChange: true })).toBeNull();
    expect(mergedTombstoneBlockReason(liveEvent, {})).toBeNull();
  });

  it("allows re-asserting REJECTED — a tombstone's own resting state", () => {
    // Idempotent, not a resurrection. Blocking it would make the guard fire on
    // a write that changes nothing, which is how guards get routed around.
    expect(mergedTombstoneBlockReason(tombstone, { nextStatus: "REJECTED" })).toBeNull();
  });

  it("allows editing non-identity fields on a tombstone", () => {
    // The row is kept as an audit record. Correcting a description or a set of
    // hours on it never makes it public, so there is nothing to block.
    expect(mergedTombstoneBlockReason(tombstone, {})).toBeNull();
  });

  it("treats an empty-string merged_into as not-merged", () => {
    // D1 columns that have been through a text round-trip can arrive as "".
    // Treating that as a live pointer would block writes on ordinary events.
    expect(mergedTombstoneBlockReason({ mergedInto: "" }, { nextStatus: "APPROVED" })).toBeNull();
  });

  it("ignores an absent or empty nextStatus rather than guessing", () => {
    expect(mergedTombstoneBlockReason(tombstone, { nextStatus: undefined })).toBeNull();
    expect(mergedTombstoneBlockReason(tombstone, { nextStatus: null })).toBeNull();
    expect(mergedTombstoneBlockReason(tombstone, { nextStatus: "" })).toBeNull();
  });
});

describe("every other status transition on a tombstone", () => {
  // The original defect went through APPROVED, but nothing about the bug is
  // specific to it — TENTATIVE and PENDING are public or public-bound too, and
  // the gate is checked before the APPROVED-only location gate for that reason.
  it.each(["APPROVED", "TENTATIVE", "PENDING", "CANCELLED"])("blocks → %s", (status) => {
    expect(mergedTombstoneBlockReason(tombstone, { nextStatus: status })).not.toBeNull();
  });
});

describe("a call that changes both status and slug", () => {
  it("blocks on the status, which is the more serious half", () => {
    const reason = mergedTombstoneBlockReason(tombstone, {
      nextStatus: "APPROVED",
      slugChange: true,
    });
    expect(reason).toContain("status=");
  });
});
