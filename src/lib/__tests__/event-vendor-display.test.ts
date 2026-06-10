import { describe, expect, it } from "vitest";

import {
  dedupeByResolvedSlug,
  resolveEventVendorTarget,
  type EventVendorDisplayRow,
  type EventVendorParentRow,
} from "@/lib/event-vendor-display";

/**
 * Guards the EH2 brand_parent collapse on event pages: a brand_parent-mode
 * office (LeafFilter shape) must surface as the brand name + hub link; self /
 * both / INDEPENDENT rows stay themselves; multiple offices of one brand at an
 * event collapse to a single card.
 */

const brandParent: EventVendorParentRow = {
  id: "sys-vendor-leaffilter-national",
  slug: "leaffilter-gutter-protection-national",
  role: "NATIONAL",
  businessName: "LeafFilter Gutter Protection",
  displayName: null,
  defaultChildDisplay: "brand_parent",
};

const office = (overrides: Partial<EventVendorDisplayRow> = {}): EventVendorDisplayRow => ({
  role: "LOCAL_OFFICE",
  brandParentVendorId: "sys-vendor-leaffilter-national",
  operatorParentVendorId: null,
  aliasOfVendorId: null,
  displayOverridePermitted: false,
  displayMode: "inherit",
  slug: "leaffilter-north-of-massachusetts",
  businessName: "LeafFilter North of Massachusetts",
  displayName: null,
  ...overrides,
});

describe("resolveEventVendorTarget", () => {
  it("collapses a brand_parent-mode office to the brand name + hub slug", () => {
    expect(resolveEventVendorTarget(office(), brandParent, null)).toEqual({
      name: "LeafFilter Gutter Protection",
      slug: "leaffilter-gutter-protection-national",
    });
  });

  it("keeps a self-mode office as itself (RbA-franchise shape)", () => {
    const selfBrand: EventVendorParentRow = { ...brandParent, defaultChildDisplay: "self" };
    expect(resolveEventVendorTarget(office(), selfBrand, null)).toEqual({
      name: "LeafFilter North of Massachusetts",
      slug: "leaffilter-north-of-massachusetts",
    });
  });

  it("leaves an INDEPENDENT vendor untouched", () => {
    const indie = office({
      role: "INDEPENDENT",
      brandParentVendorId: null,
      slug: "joes-kettle-corn",
      businessName: "Joe's Kettle Corn",
    });
    expect(resolveEventVendorTarget(indie, null, null)).toEqual({
      name: "Joe's Kettle Corn",
      slug: "joes-kettle-corn",
    });
  });

  it("falls back to self when the brand parent row wasn't loaded", () => {
    expect(resolveEventVendorTarget(office(), null, null)).toEqual({
      name: "LeafFilter North of Massachusetts",
      slug: "leaffilter-north-of-massachusetts",
    });
  });

  it("honors a brand display_name override on collapse", () => {
    const named: EventVendorParentRow = { ...brandParent, displayName: "LeafFilter" };
    expect(resolveEventVendorTarget(office(), named, null).name).toBe("LeafFilter");
  });
});

describe("dedupeByResolvedSlug", () => {
  it("collapses two offices of the same brand into one, preserving order", () => {
    const rows = [
      { id: "a", slug: "leaffilter-gutter-protection-national" },
      { id: "b", slug: "leaffilter-gutter-protection-national" },
      { id: "c", slug: "joes-kettle-corn" },
    ];
    expect(dedupeByResolvedSlug(rows, (r) => r.slug).map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("is a no-op when every slug is distinct", () => {
    const rows = [{ slug: "x" }, { slug: "y" }, { slug: "z" }];
    expect(dedupeByResolvedSlug(rows, (r) => r.slug)).toHaveLength(3);
  });
});
