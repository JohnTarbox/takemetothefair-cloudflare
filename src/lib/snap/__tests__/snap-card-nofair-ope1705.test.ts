/**
 * OPE-1705 slice 3 — the phone's line for a business card handled with NO fair
 * (an ack with no resulting event), and for a card that created its vendor.
 */
import { describe, it, expect } from "vitest";
import { describeSnap, cardNoFairLabel, type SnapRowFacts } from "../status";

const row = (over: Partial<SnapRowFacts> = {}): SnapRowFacts => ({
  id: "snap-1",
  status: "replied",
  replyKind: "photo-intake-ack",
  resultingEventId: null,
  captureMeta: JSON.stringify({ location_source: "none", no_fair: true }),
  error: null,
  ...over,
});
const base = { boothProposals: 0, boothAutowritten: 0, performer: 0, gallery: 0, signage: 0 };

describe("describeSnap — cards with no fair", () => {
  it("a card that created its vendor reads 'new vendor', and is not 'Held'", () => {
    const s = describeSnap(row(), null, {
      ...base,
      cardApplied: 1,
      cardVendorName: "Alder Brook Soaps",
      cardCreated: true,
    });
    expect(s.phase).toBe("matched");
    expect(s.label).toBe("Business card → new vendor Alder Brook Soaps (no fair)");
  });

  it("a matched card names its vendor", () => {
    expect(
      describeSnap(row(), null, { ...base, cardApplied: 1, cardVendorName: "Fern Hollow" }).label
    ).toBe("Business card → Fern Hollow (no fair)");
  });

  it("a card kept for review says so", () => {
    expect(describeSnap(row(), null, { ...base, cardProposed: 1 }).label).toMatch(
      /card only, kept for review/
    );
  });

  it("an ack with no event and NO card outcome is still 'Held' (landmark: the branch is card-only)", () => {
    expect(describeSnap(row(), null, base).phase).toBe("held");
    expect(cardNoFairLabel(base)).toBeNull();
  });

  it("at a fair, a created card reads 'new vendor' too", () => {
    const s = describeSnap(row({ resultingEventId: "ev1" }), "CMP Fair", {
      ...base,
      cardApplied: 1,
      cardVendorName: "Alder Brook Soaps",
      cardCreated: true,
    });
    expect(s.label).toBe("CMP Fair — Business card → new vendor Alder Brook Soaps");
  });
});
