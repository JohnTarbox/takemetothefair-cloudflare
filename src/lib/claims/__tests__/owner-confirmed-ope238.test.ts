/**
 * OPE-238 — the ownership badge requires BOTH halves.
 *
 * The defect was a single-condition badge: it rendered off `vendors.claimed`
 * alone, so a claim became publicly endorsed the instant somebody registered,
 * while `emailVerified` was still false by construction (the register route
 * says so itself — "Always false here — verification lands minutes-to-hours
 * later"). 26 of 73 claimants had never confirmed an address.
 *
 * The case that matters most is the LAST one: an un-updated caller, which must
 * render nothing rather than fall back to the old behaviour.
 */
import { describe, it, expect } from "vitest";
import { isOwnerConfirmed } from "../owner-confirmed";

describe("isOwnerConfirmed", () => {
  it("is true only when claimed AND the owner confirmed their email", () => {
    expect(isOwnerConfirmed({ claimed: true, ownerEmailVerified: true })).toBe(true);
  });

  it("is FALSE for a claim whose owner never verified — the whole defect", () => {
    // This exact row shape is what put a trust badge on 26 listings.
    expect(isOwnerConfirmed({ claimed: true, ownerEmailVerified: false })).toBe(false);
  });

  it("is false for a verified user who claimed nothing", () => {
    // Verification alone is not an ownership statement — plenty of accounts
    // confirm an email without ever claiming a listing.
    expect(isOwnerConfirmed({ claimed: false, ownerEmailVerified: true })).toBe(false);
  });

  it("is false when neither holds", () => {
    expect(isOwnerConfirmed({ claimed: false, ownerEmailVerified: false })).toBe(false);
  });

  it("FAILS CLOSED when the caller never fetched ownerEmailVerified", () => {
    // The load-bearing case. Three surfaces render this badge from three
    // different queries; a caller that has not been updated passes only
    // `claimed`. It must render NOTHING, not the pre-OPE-238 badge — a missing
    // badge is a far smaller error than one that was not earned.
    expect(isOwnerConfirmed({ claimed: true })).toBe(false);
    expect(isOwnerConfirmed({ claimed: true, ownerEmailVerified: null })).toBe(false);
    expect(isOwnerConfirmed({ claimed: true, ownerEmailVerified: undefined })).toBe(false);
  });

  it("treats a null claim as unclaimed rather than throwing", () => {
    // `vendors.claimed` is nullable in the schema; an empty collection or a
    // null column must never crash a listing page (the OPE-58 class).
    expect(isOwnerConfirmed({ claimed: null, ownerEmailVerified: true })).toBe(false);
    expect(isOwnerConfirmed({})).toBe(false);
  });
});
