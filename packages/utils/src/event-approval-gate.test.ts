/**
 * OPE-244 #3 — the approval invariant. The 2 events that shipped invalid Event
 * schema (Artisans' Market in Unity, Vermont Maple) were exactly this shape:
 * APPROVED with no venue and not statewide. These lock the gate.
 */
import { describe, it, expect } from "vitest";
import { eventApprovalBlockReason } from "./event-approval-gate";

describe("eventApprovalBlockReason (OPE-244)", () => {
  it("passes an event with a venue (the normal case)", () => {
    expect(eventApprovalBlockReason({ venueId: "v1", isStatewide: false })).toBeNull();
    expect(eventApprovalBlockReason({ venueId: "v1", isStatewide: true })).toBeNull();
  });

  it("BLOCKS a venue-less, non-statewide event (the invalid-schema shape)", () => {
    const r = eventApprovalBlockReason({ venueId: null, isStatewide: false });
    expect(r).toContain("no venue");
    expect(r).toContain("statewide");
  });

  it("passes a statewide event with a state code (valid AdministrativeArea location)", () => {
    expect(
      eventApprovalBlockReason({ venueId: null, isStatewide: true, stateCode: "ME" })
    ).toBeNull();
  });

  it("BLOCKS a statewide event with no state code (still no derivable location)", () => {
    const r = eventApprovalBlockReason({ venueId: null, isStatewide: true, stateCode: null });
    expect(r).toContain("state_code");
  });

  it("treats an empty-string venueId as no venue", () => {
    expect(eventApprovalBlockReason({ venueId: "", isStatewide: false })).not.toBeNull();
  });
});
