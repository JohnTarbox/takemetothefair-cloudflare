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

// OPE-1114 — reviewer notes left in public copy.
import { reviewerMarkerInCopy } from "./event-approval-gate";

describe("reviewerMarkerInCopy", () => {
  it("catches the Pemaquid specimen, verbatim", () => {
    expect(
      reviewerMarkerInCopy(
        "VENUE TO CONFIRM: traditionally held at Schooner Landing Restaurant & Marina in downtown Damariscotta; some recent editions have reportedly relocated — reviewer should confirm the 2026 venue before approval."
      )
    ).not.toBeNull();
  });

  it.each([
    ["reviewer should confirm hours", "reviewer should"],
    ["Confirm the fee before approving.", "before approving"],
    ["Dates NEEDS VERIFICATION", "NEEDS VERIFICATION"],
    ["Parking TO VERIFY", "TO VERIFY"],
    ["TODO: add vendors", "TODO"],
  ])("matches %j", (text, marker) => {
    expect(reviewerMarkerInCopy(text)).toBe(marker);
  });

  it("does NOT match honest reader-facing hedges (the two live rows that say so)", () => {
    // rockland-farmers-market-winter-2026 / augusta-farmers-market-winter-2026-2027
    expect(reviewerMarkerInCopy("Hours subject to confirmation.")).toBeNull();
    expect(reviewerMarkerInCopy("Please confirm with the organizer before you go.")).toBeNull();
    expect(reviewerMarkerInCopy("A family day with things to do.")).toBeNull(); // lower-case "to do"
    expect(reviewerMarkerInCopy(null)).toBeNull();
  });
});
