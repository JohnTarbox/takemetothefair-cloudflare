/**
 * OPE-1564 — the one public line for who may be a vendor. OPEN (the default
 * every existing row takes) must render NOTHING, so an event with no value set
 * looks exactly as it did before the column existed.
 */
import { describe, it, expect } from "vitest";
import {
  VENDOR_ELIGIBILITY_VALUES,
  isVendorEligibility,
  vendorEligibilityLine,
} from "./vendor-eligibility";

describe("vendorEligibilityLine (OPE-1564)", () => {
  it("says nothing for OPEN, null, undefined or an unrecognised stored value", () => {
    expect(vendorEligibilityLine("OPEN", "The Craftworkers' Guild")).toBeNull();
    expect(vendorEligibilityLine(null)).toBeNull();
    expect(vendorEligibilityLine(undefined)).toBeNull();
    expect(vendorEligibilityLine("members_only")).toBeNull();
  });

  it("names the org for MEMBERS_ONLY — John's sentence for the Craftworkers shop", () => {
    expect(vendorEligibilityLine("MEMBERS_ONLY", "The Craftworkers' Guild")).toBe(
      "To be a vendor, you must be a member of The Craftworkers' Guild."
    );
  });

  it("does not double a trailing period on the stored org name", () => {
    expect(vendorEligibilityLine("MEMBERS_ONLY", "Guild Inc.")).toBe(
      "To be a vendor, you must be a member of Guild Inc."
    );
  });

  it("still says members-only when no org is recorded", () => {
    expect(vendorEligibilityLine("MEMBERS_ONLY", "  ")).toBe(
      "To be a vendor, you must be a member of the organizing group."
    );
  });

  it("states the selection method for JURIED / INVITATION_ONLY, never an org (no how-to-join)", () => {
    expect(vendorEligibilityLine("JURIED", "Some Jury")).toBe(
      "To be a vendor, you must be accepted by the show's jury."
    );
    expect(vendorEligibilityLine("INVITATION_ONLY", "Some Org")).toBe(
      "To be a vendor, you must be invited by the organizer."
    );
  });

  it("every non-OPEN value renders a line (a new enum value cannot ship silent)", () => {
    const silent = VENDOR_ELIGIBILITY_VALUES.filter(
      (v) => v !== "OPEN" && vendorEligibilityLine(v) === null
    );
    expect(VENDOR_ELIGIBILITY_VALUES.length).toBe(4);
    expect(silent).toEqual([]);
  });

  it("isVendorEligibility accepts exactly the enum", () => {
    expect(VENDOR_ELIGIBILITY_VALUES.every(isVendorEligibility)).toBe(true);
    expect(isVendorEligibility("CLOSED")).toBe(false);
    expect(isVendorEligibility(1)).toBe(false);
  });
});
