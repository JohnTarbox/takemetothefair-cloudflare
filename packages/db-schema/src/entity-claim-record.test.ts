/**
 * OPE-236 §4 — tests for the shared claim-row rule.
 *
 * Each case is written so it FAILS if the behaviour under test is removed, not
 * merely if the module is absent: an assertion that only checks the shape of
 * the returned object would pass with `status` hardcoded to "PENDING", which is
 * the defect that would put an already-granted claim back into the review queue.
 */
import { describe, it, expect } from "vitest";
import { buildSettledEntityClaim, shouldRecordEntityClaim } from "./entity-claim-record";

const AT = new Date("2026-08-31T12:00:00Z");

describe("buildSettledEntityClaim", () => {
  it("is born APPROVED and decided, not PENDING awaiting review", () => {
    const row = buildSettledEntityClaim({
      entityType: "VENDOR",
      entityId: "v1",
      userId: "u1",
      method: "ADMIN",
      decidedBy: "admin1",
      at: AT,
    });
    // A PENDING row would ask an admin to approve access the claimant is
    // already exercising — the specific wrong answer this pins.
    expect(row.status).toBe("APPROVED");
    expect(row.decidedAt).toEqual(AT);
    expect(row.decidedBy).toBe("admin1");
  });

  it("credits the settler, who is NOT the claimant on the admin path", () => {
    const row = buildSettledEntityClaim({
      entityType: "VENDOR",
      entityId: "v1",
      userId: "claimant",
      method: "ADMIN",
      decidedBy: "the-admin",
      at: AT,
    });
    // Collapsing decidedBy into userId would erase the fact that a human
    // admin, not the claimant, authorised an out-of-band approval.
    expect(row.userId).toBe("claimant");
    expect(row.decidedBy).toBe("the-admin");
    expect(row.userId).not.toBe(row.decidedBy);
  });

  it("carries the caller's evidence text through to the row", () => {
    const row = buildSettledEntityClaim({
      entityType: "VENDOR",
      entityId: "v1",
      userId: "u1",
      method: "EMAIL_MATCH",
      decidedBy: "u1",
      at: AT,
      evidence: "account email matches vendor.contact_email (a@b.test)",
    });
    expect(row.evidence).toBe("account email matches vendor.contact_email (a@b.test)");
  });

  it("normalises a missing evidence to null, not undefined", () => {
    // undefined would make drizzle omit the column rather than write NULL —
    // harmless for a nullable column today, and a silent default-swallower if
    // one is ever added.
    const row = buildSettledEntityClaim({
      entityType: "PROMOTER",
      entityId: "p1",
      userId: "u1",
      method: "ADMIN",
      decidedBy: "a1",
      at: AT,
    });
    expect(row.evidence).toBeNull();
  });
});

describe("shouldRecordEntityClaim", () => {
  it("records when the table holds nothing for this entity", () => {
    expect(shouldRecordEntityClaim([], "u1")).toBe(true);
  });

  it("refuses a second row for the same claimant — the double-click case", () => {
    // A mail client prefetching a confirmation link, then the person clicking
    // it, is two settled runs of the same claim. Without this the queue
    // double-counts one claim.
    expect(shouldRecordEntityClaim([{ userId: "u1", status: "APPROVED" }], "u1")).toBe(false);
  });

  it("still records when the SAME user's prior claim was REJECTED", () => {
    // Keying on the entity alone would refuse here and lose the row for a
    // claim an admin has just deliberately granted after an earlier refusal.
    expect(shouldRecordEntityClaim([{ userId: "u1", status: "REJECTED" }], "u1")).toBe(true);
  });

  it("still records when the entity is claimed by a DIFFERENT user — a transfer", () => {
    // The admin tool refuses cross-user overwrites before reaching here, so a
    // row under another user means a deliberate transfer already happened.
    expect(shouldRecordEntityClaim([{ userId: "someone-else", status: "APPROVED" }], "u1")).toBe(
      true
    );
  });

  it("does not treat a PENDING row from another path as already recorded", () => {
    // A PENDING row means review has not settled; the settled path must still
    // write its APPROVED row rather than leave the claim looking unresolved.
    expect(shouldRecordEntityClaim([{ userId: "u1", status: "PENDING" }], "u1")).toBe(true);
  });
});
