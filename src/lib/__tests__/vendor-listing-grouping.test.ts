import { describe, expect, it } from "vitest";
import {
  collectBrandParentIdsToLoad,
  groupVendorsForListing,
  type GroupableVendor,
} from "../vendor-listing-grouping";

// Builders — state only what differs from the default.

function ind(id: string, overrides: Partial<GroupableVendor> = {}): GroupableVendor {
  return {
    id,
    role: "INDEPENDENT",
    brandParentVendorId: null,
    operatorParentVendorId: null,
    aliasOfVendorId: null,
    displayOverridePermitted: false,
    displayMode: null,
    defaultChildDisplay: null,
    ...overrides,
  };
}

function national(
  id: string,
  defaultChildDisplay: "self" | "brand_parent" | "both" | null = "brand_parent"
): GroupableVendor {
  return {
    id,
    role: "NATIONAL",
    brandParentVendorId: null,
    operatorParentVendorId: null,
    aliasOfVendorId: null,
    displayOverridePermitted: false,
    displayMode: null,
    defaultChildDisplay,
  };
}

function office(
  id: string,
  brandId: string,
  overrides: Partial<GroupableVendor> = {}
): GroupableVendor {
  return {
    id,
    role: "LOCAL_OFFICE",
    brandParentVendorId: brandId,
    operatorParentVendorId: null,
    aliasOfVendorId: null,
    displayOverridePermitted: false,
    displayMode: "inherit",
    defaultChildDisplay: null,
    ...overrides,
  };
}

describe("collectBrandParentIdsToLoad", () => {
  it("returns empty when there are no LOCAL_OFFICE rows", () => {
    expect(collectBrandParentIdsToLoad([ind("a"), ind("b"), national("brand-1")])).toEqual([]);
  });

  it("returns the deduped set of brand_parent ids referenced by offices", () => {
    const ids = collectBrandParentIdsToLoad([
      ind("a"),
      office("office-1", "brand-1"),
      office("office-2", "brand-1"),
      office("office-3", "brand-2"),
    ]);
    expect(ids.sort()).toEqual(["brand-1", "brand-2"]);
  });

  it("skips offices with null brand_parent_vendor_id (orphans)", () => {
    expect(
      collectBrandParentIdsToLoad([office("orphan", "" as never, { brandParentVendorId: null })])
    ).toEqual([]);
  });
});

describe("groupVendorsForListing — INDEPENDENT (cache-key parity)", () => {
  it("emits one card per INDEPENDENT row, in input order", () => {
    const cards = groupVendorsForListing({
      matchedVendors: [ind("a"), ind("b"), ind("c")],
      brandParentsById: new Map(),
      officesByBrandId: new Map(),
    });
    expect(cards).toEqual([
      { vendorId: "a", aggregatedEventVendorIds: ["a"], isBrandCollapsed: false },
      { vendorId: "b", aggregatedEventVendorIds: ["b"], isBrandCollapsed: false },
      { vendorId: "c", aggregatedEventVendorIds: ["c"], isBrandCollapsed: false },
    ]);
  });
});

describe("groupVendorsForListing — brand_parent-mode collapse (LeafFilter shape)", () => {
  it("collapses N offices into ONE brand card", () => {
    // §A repro: user types "leaf" → LeafFilter brand row + 1 office match.
    // Listing should return ONE card (the brand) not two competing rows.
    const brand = national("leaffilter-id", "brand_parent");
    const officeMA = office("office-ma", "leaffilter-id");
    const officeME = office("office-me", "leaffilter-id");
    const cards = groupVendorsForListing({
      matchedVendors: [brand, officeMA, officeME],
      brandParentsById: new Map([["leaffilter-id", brand]]),
      officesByBrandId: new Map([["leaffilter-id", [officeMA, officeME]]]),
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].vendorId).toBe("leaffilter-id");
    expect(cards[0].isBrandCollapsed).toBe(true);
    // Aggregated events come from brand + all offices in the group.
    expect(cards[0].aggregatedEventVendorIds.sort()).toEqual(
      ["leaffilter-id", "office-ma", "office-me"].sort()
    );
  });

  it("emits the brand card even when ONLY offices matched (search hit office, not brand)", () => {
    // User searches "Portland" → matches the Portland office only; brand row
    // not in match set. Listing should still collapse to a brand card,
    // pulling the brand row in via the brandParentsById map.
    const brand = national("leaffilter-id", "brand_parent");
    const officeME = office("office-me", "leaffilter-id");
    const cards = groupVendorsForListing({
      matchedVendors: [officeME],
      brandParentsById: new Map([["leaffilter-id", brand]]),
      officesByBrandId: new Map([["leaffilter-id", [officeME]]]),
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].vendorId).toBe("leaffilter-id");
    expect(cards[0].isBrandCollapsed).toBe(true);
  });

  it("collapses to ONE card when only the brand row matched (no offices in match set)", () => {
    // User searches exact "LeafFilter" → only brand row matches.
    // Brand-mode brand still renders as a collapsed card with aggregated
    // events from all of its offices (the offices are not in the match
    // set, but the caller populates officesByBrandId so events still
    // surface on the brand card).
    const brand = national("leaffilter-id", "brand_parent");
    const officeMA = office("office-ma", "leaffilter-id");
    const officeME = office("office-me", "leaffilter-id");
    const cards = groupVendorsForListing({
      matchedVendors: [brand],
      brandParentsById: new Map([["leaffilter-id", brand]]),
      officesByBrandId: new Map([["leaffilter-id", [officeMA, officeME]]]),
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].vendorId).toBe("leaffilter-id");
    expect(cards[0].aggregatedEventVendorIds.sort()).toEqual(
      ["leaffilter-id", "office-ma", "office-me"].sort()
    );
  });
});

describe("groupVendorsForListing — self-mode brand (RbA shape)", () => {
  it("emits N franchise cards, suppresses the brand hub from the listing", () => {
    // §E acceptance: /vendors?q=renewal returns 5 RbA franchise cards,
    // NOT the sys-vendor-rba-national row.
    const rba = national("rba-id", "self");
    const franchise1 = office("franchise-1", "rba-id");
    const franchise2 = office("franchise-2", "rba-id");
    const franchise3 = office("franchise-3", "rba-id");
    const cards = groupVendorsForListing({
      matchedVendors: [rba, franchise1, franchise2, franchise3],
      brandParentsById: new Map([["rba-id", rba]]),
      officesByBrandId: new Map([["rba-id", [franchise1, franchise2, franchise3]]]),
    });
    // 3 franchise cards, no brand card.
    expect(cards.map((c) => c.vendorId).sort()).toEqual(
      ["franchise-1", "franchise-2", "franchise-3"].sort()
    );
    expect(cards.every((c) => !c.isBrandCollapsed)).toBe(true);
  });

  it("drops a self-mode brand row from listing even when its match is direct (no offices)", () => {
    // User searches "Renewal by Andersen" exactly. Only the brand row
    // matches (no franchise has that exact substring). Per spec: brand
    // hub does NOT render in listing under self mode.
    const rba = national("rba-id", "self");
    const cards = groupVendorsForListing({
      matchedVendors: [rba],
      brandParentsById: new Map([["rba-id", rba]]),
      officesByBrandId: new Map(),
    });
    expect(cards).toHaveLength(0);
  });
});

describe("groupVendorsForListing — 'both' mode (v1 treats like self for the listing)", () => {
  it("emits per-office cards and suppresses the brand hub from the listing", () => {
    // 'both' renders the office's page as canonical (with a composite
    // "<office> — <brand>" name via displayVendorName). The brand hub
    // is NOT a separate listing card.
    const brand = national("brand-id", "both");
    const office1 = office("office-1", "brand-id");
    const office2 = office("office-2", "brand-id");
    const cards = groupVendorsForListing({
      matchedVendors: [brand, office1, office2],
      brandParentsById: new Map([["brand-id", brand]]),
      officesByBrandId: new Map([["brand-id", [office1, office2]]]),
    });
    expect(cards.map((c) => c.vendorId).sort()).toEqual(["office-1", "office-2"]);
  });
});

describe("groupVendorsForListing — child override path (spec §4 step 3)", () => {
  it("ignores override to 'self' when the parent's gate is closed (parent wins)", () => {
    // Parent default=brand_parent, child says 'self', but the gate is
    // closed (displayOverridePermitted=false). Parent's gate always wins
    // → resolved mode is brand_parent → office folds into brand card.
    const brand = national("brand-id", "brand_parent");
    const child = office("child-1", "brand-id", {
      displayOverridePermitted: false,
      displayMode: "self",
    });
    const cards = groupVendorsForListing({
      matchedVendors: [child],
      brandParentsById: new Map([["brand-id", brand]]),
      officesByBrandId: new Map([["brand-id", [child]]]),
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].vendorId).toBe("brand-id");
    expect(cards[0].isBrandCollapsed).toBe(true);
  });

  it("listing collapses whole brand when ANY office is brand-parent-mode (per-office gate is detail-page concern)", () => {
    // Spec §4.4 says the per-office gate is "parent's gate always wins,"
    // controlling the OFFICE DETAIL PAGE. The spec is silent on whether
    // the listing's grouping rule respects per-office overrides.
    //
    // The v1 implementation lock-in: the LISTING groups by brand whenever
    // the brand opted into collapse (default_child_display='brand_parent').
    // Per-office overrides are honored on /vendors/<office-slug> (the
    // detail page rendering — handled by displayVendorName's resolver) but
    // not at the listing level. Rationale: a fragmented listing with
    // "brand card + one opted-out office card" is more confusing than
    // useful for a normal browser, and the operator path for opt-out
    // exists for fixing detail pages, not listing surfaces.
    const brand = national("brand-id", "brand_parent");
    const optedOut = office("opted-out", "brand-id", {
      displayOverridePermitted: true,
      displayMode: "self",
    });
    const collapsing = office("collapsing", "brand-id");
    const cards = groupVendorsForListing({
      matchedVendors: [optedOut, collapsing],
      brandParentsById: new Map([["brand-id", brand]]),
      officesByBrandId: new Map([["brand-id", [optedOut, collapsing]]]),
    });
    // ONE brand card. Both offices' events aggregate into it.
    expect(cards).toHaveLength(1);
    expect(cards[0].vendorId).toBe("brand-id");
    expect(cards[0].isBrandCollapsed).toBe(true);
    expect(cards[0].aggregatedEventVendorIds.sort()).toEqual(
      ["brand-id", "collapsing", "opted-out"].sort()
    );
  });
});

describe("groupVendorsForListing — edge cases", () => {
  it("preserves input order for independent + collapsed mixed", () => {
    const a = ind("a");
    const brand = national("brand-id", "brand_parent");
    const officeOf = office("office-of", "brand-id");
    const z = ind("z");
    const cards = groupVendorsForListing({
      matchedVendors: [a, officeOf, z],
      brandParentsById: new Map([["brand-id", brand]]),
      officesByBrandId: new Map([["brand-id", [officeOf]]]),
    });
    expect(cards.map((c) => c.vendorId)).toEqual(["a", "brand-id", "z"]);
  });

  it("falls back to office self-render when the brand row isn't in the lookup (data drift safety)", () => {
    // The caller failed to populate brandParentsById for this office.
    // The grouping rule defaults to 'self' (resolveVendorDisplay's
    // missing-parent fallback) — render the office, don't drop it.
    const orphan = office("orphan", "missing-brand-id");
    const cards = groupVendorsForListing({
      matchedVendors: [orphan],
      brandParentsById: new Map(),
      officesByBrandId: new Map(),
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].vendorId).toBe("orphan");
    expect(cards[0].isBrandCollapsed).toBe(false);
  });

  it("collapses only ONCE when the brand row + multiple offices all match", () => {
    // Pathological case where the user's search hits brand + 3 offices.
    // Card list should be 1 (the brand), not 4 (brand + 3 copies).
    const brand = national("brand-id", "brand_parent");
    const o1 = office("o1", "brand-id");
    const o2 = office("o2", "brand-id");
    const o3 = office("o3", "brand-id");
    const cards = groupVendorsForListing({
      matchedVendors: [brand, o1, o2, o3],
      brandParentsById: new Map([["brand-id", brand]]),
      officesByBrandId: new Map([["brand-id", [o1, o2, o3]]]),
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].vendorId).toBe("brand-id");
  });

  it("when brand row not in match set, the FIRST office's position is where the brand card lands", () => {
    const a = ind("a");
    const brand = national("brand-id", "brand_parent");
    const officeFirst = office("first-office", "brand-id");
    const officeSecond = office("second-office", "brand-id");
    const z = ind("z");
    const cards = groupVendorsForListing({
      matchedVendors: [a, officeFirst, z, officeSecond],
      brandParentsById: new Map([["brand-id", brand]]),
      officesByBrandId: new Map([["brand-id", [officeFirst, officeSecond]]]),
    });
    // brand card lands at first-office's position; second-office is dropped.
    expect(cards.map((c) => c.vendorId)).toEqual(["a", "brand-id", "z"]);
  });
});
