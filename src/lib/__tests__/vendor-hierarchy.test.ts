import { describe, expect, it } from "vitest";
import {
  canonicalParentSlugFor,
  resolveAlias,
  resolveVendorDisplay,
  type DisplayableParent,
  type DisplayableVendor,
} from "../vendor-hierarchy";

// Helper builders — make the test bodies legible by stating only the
// fields that differ from the default-shape row.

function vendor(overrides: Partial<DisplayableVendor> = {}): DisplayableVendor {
  return {
    role: "INDEPENDENT",
    brandParentVendorId: null,
    operatorParentVendorId: null,
    aliasOfVendorId: null,
    displayOverridePermitted: false,
    displayMode: null,
    ...overrides,
  };
}

function parent(overrides: Partial<DisplayableParent> = {}): DisplayableParent {
  return {
    id: "parent-id",
    role: "NATIONAL",
    defaultChildDisplay: "self",
    ...overrides,
  };
}

describe("resolveVendorDisplay", () => {
  describe("no brand parent → self (spec §4 step 2)", () => {
    it("returns 'self' for INDEPENDENT regardless of parent ref", () => {
      expect(resolveVendorDisplay(vendor({ role: "INDEPENDENT" }))).toBe("self");
      // A stray parent ref shouldn't change it — no brand_parent on the row.
      expect(resolveVendorDisplay(vendor({ role: "INDEPENDENT" }), parent())).toBe("self");
    });

    it("returns 'self' for NATIONAL (the brand IS its own canonical)", () => {
      expect(
        resolveVendorDisplay(vendor({ role: "NATIONAL", defaultChildDisplay: "self" } as never))
      ).toBe("self");
    });

    it("returns 'self' for LOCAL_OFFICE when brandParentVendorId is null (orphan)", () => {
      expect(resolveVendorDisplay(vendor({ role: "LOCAL_OFFICE" }))).toBe("self");
    });
  });

  describe("LOCAL_OFFICE — orphan/safety defaults", () => {
    it("falls back to 'self' when parent ref isn't loaded", () => {
      expect(
        resolveVendorDisplay(
          vendor({ role: "LOCAL_OFFICE", brandParentVendorId: "p1" })
          // parent omitted
        )
      ).toBe("self");
    });

    it("falls back to 'self' when parent is null (DB miss)", () => {
      expect(
        resolveVendorDisplay(vendor({ role: "LOCAL_OFFICE", brandParentVendorId: "p1" }), null)
      ).toBe("self");
    });
  });

  describe("LOCAL_OFFICE — default path (no override) — spec §4 step 4", () => {
    it("uses parent.defaultChildDisplay='self' when child mode is 'inherit'", () => {
      expect(
        resolveVendorDisplay(
          vendor({
            role: "LOCAL_OFFICE",
            brandParentVendorId: "p1",
            displayMode: "inherit",
          }),
          parent({ defaultChildDisplay: "self" })
        )
      ).toBe("self");
    });

    it("uses parent.defaultChildDisplay='brand_parent' when child mode is 'inherit'", () => {
      expect(
        resolveVendorDisplay(
          vendor({
            role: "LOCAL_OFFICE",
            brandParentVendorId: "p1",
            displayMode: "inherit",
          }),
          parent({ defaultChildDisplay: "brand_parent" })
        )
      ).toBe("brand_parent");
    });

    it("uses parent.defaultChildDisplay='both' when child mode is 'inherit'", () => {
      expect(
        resolveVendorDisplay(
          vendor({
            role: "LOCAL_OFFICE",
            brandParentVendorId: "p1",
            displayMode: "inherit",
          }),
          parent({ defaultChildDisplay: "both" })
        )
      ).toBe("both");
    });

    it("ignores child preference when displayOverridePermitted=false (gate closed)", () => {
      // Parent gate closed — child says brand_parent but parent says self.
      // Parent wins. Encodes spec §4.4 "parent's gate always wins".
      expect(
        resolveVendorDisplay(
          vendor({
            role: "LOCAL_OFFICE",
            brandParentVendorId: "p1",
            displayOverridePermitted: false,
            displayMode: "brand_parent",
          }),
          parent({ defaultChildDisplay: "self" })
        )
      ).toBe("self");
    });

    it("falls back to 'self' when parent.defaultChildDisplay is NULL", () => {
      expect(
        resolveVendorDisplay(
          vendor({
            role: "LOCAL_OFFICE",
            brandParentVendorId: "p1",
            displayMode: "inherit",
          }),
          parent({ defaultChildDisplay: null })
        )
      ).toBe("self");
    });
  });

  describe("LOCAL_OFFICE — override path — spec §4 step 3", () => {
    it("uses child preference when gate=true and mode='brand_parent'", () => {
      expect(
        resolveVendorDisplay(
          vendor({
            role: "LOCAL_OFFICE",
            brandParentVendorId: "p1",
            displayOverridePermitted: true,
            displayMode: "brand_parent",
          }),
          parent({ defaultChildDisplay: "self" })
        )
      ).toBe("brand_parent");
    });

    it("uses child preference when gate=true and mode='self'", () => {
      expect(
        resolveVendorDisplay(
          vendor({
            role: "LOCAL_OFFICE",
            brandParentVendorId: "p1",
            displayOverridePermitted: true,
            displayMode: "self",
          }),
          parent({ defaultChildDisplay: "brand_parent" })
        )
      ).toBe("self");
    });

    it("uses child preference when gate=true and mode='operator_parent'", () => {
      expect(
        resolveVendorDisplay(
          vendor({
            role: "LOCAL_OFFICE",
            brandParentVendorId: "p1",
            operatorParentVendorId: "op1",
            displayOverridePermitted: true,
            displayMode: "operator_parent",
          }),
          parent({ defaultChildDisplay: "brand_parent" })
        )
      ).toBe("operator_parent");
    });

    it("uses child preference when gate=true and mode='both'", () => {
      expect(
        resolveVendorDisplay(
          vendor({
            role: "LOCAL_OFFICE",
            brandParentVendorId: "p1",
            displayOverridePermitted: true,
            displayMode: "both",
          }),
          parent({ defaultChildDisplay: "self" })
        )
      ).toBe("both");
    });

    it("falls through to parent default when gate=true but mode='inherit'", () => {
      expect(
        resolveVendorDisplay(
          vendor({
            role: "LOCAL_OFFICE",
            brandParentVendorId: "p1",
            displayOverridePermitted: true,
            displayMode: "inherit",
          }),
          parent({ defaultChildDisplay: "brand_parent" })
        )
      ).toBe("brand_parent");
    });

    it("falls through to parent default when gate=true but mode=NULL", () => {
      expect(
        resolveVendorDisplay(
          vendor({
            role: "LOCAL_OFFICE",
            brandParentVendorId: "p1",
            displayOverridePermitted: true,
            displayMode: null,
          }),
          parent({ defaultChildDisplay: "self" })
        )
      ).toBe("self");
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// resolveAlias — spec §4 step 1 + spec §3.3 (alias separate from parent)
// ────────────────────────────────────────────────────────────────────────

describe("resolveAlias", () => {
  // Lookups built via a Map. The caller-supplied lookup pattern matches
  // how the render page will do it: load the alias chain in a single
  // batched query, then pass an id→row function in.
  function makeLookup(rows: Record<string, DisplayableVendor>) {
    return (id: string) => rows[id] ?? null;
  }

  it("returns the input row when aliasOfVendorId is null (no alias)", () => {
    const v = vendor({ aliasOfVendorId: null });
    expect(resolveAlias(v, makeLookup({}))).toBe(v);
  });

  it("follows one hop to the canonical", () => {
    const canonical = vendor({ aliasOfVendorId: null });
    const alias = vendor({ aliasOfVendorId: "canonical-id" });
    const out = resolveAlias(alias, makeLookup({ "canonical-id": canonical }));
    expect(out).toBe(canonical);
  });

  it("follows multi-hop chain to terminal canonical", () => {
    const canonical = vendor({ aliasOfVendorId: null });
    const middle = vendor({ aliasOfVendorId: "canonical-id" });
    const start = vendor({ aliasOfVendorId: "middle-id" });
    const out = resolveAlias(start, makeLookup({ "middle-id": middle, "canonical-id": canonical }));
    expect(out).toBe(canonical);
  });

  it("returns the deepest reachable row when chain terminates in a dangling FK", () => {
    // Alias points at an id that lookup() doesn't resolve (deleted row).
    // Better to render the dangling row's own page than throw.
    const start = vendor({ aliasOfVendorId: "missing-id" });
    expect(resolveAlias(start, makeLookup({}))).toBe(start);
  });

  it("throws on a 2-cycle (A → B → A)", () => {
    const a = vendor({ aliasOfVendorId: "b-id" });
    const b = vendor({ aliasOfVendorId: "a-id" });
    expect(() => resolveAlias(a, makeLookup({ "a-id": a, "b-id": b }))).toThrow(/cycle/i);
  });

  it("throws when chain exceeds depth cap", () => {
    // Chain of 6 hops — depth cap is 5.
    const rows: Record<string, DisplayableVendor> = {};
    for (let i = 1; i <= 6; i++) {
      rows[`v${i}`] = vendor({ aliasOfVendorId: i < 6 ? `v${i + 1}` : `v7` });
    }
    rows["v7"] = vendor({ aliasOfVendorId: "v8" });
    rows["v8"] = vendor({ aliasOfVendorId: "v9" });
    const start = vendor({ aliasOfVendorId: "v1" });
    expect(() => resolveAlias(start, makeLookup(rows))).toThrow(/depth/i);
  });
});

// ────────────────────────────────────────────────────────────────────────
// canonicalParentSlugFor
// ────────────────────────────────────────────────────────────────────────

describe("canonicalParentSlugFor", () => {
  it("returns null for INDEPENDENT vendors", () => {
    expect(canonicalParentSlugFor(vendor({ role: "INDEPENDENT" }))).toBeNull();
  });

  it("returns null for NATIONAL vendors", () => {
    expect(canonicalParentSlugFor(vendor({ role: "NATIONAL" }))).toBeNull();
  });

  it("returns null when LOCAL_OFFICE resolves to 'self'", () => {
    expect(
      canonicalParentSlugFor(
        vendor({
          role: "LOCAL_OFFICE",
          brandParentVendorId: "p1",
          displayMode: "inherit",
        }),
        parent({ defaultChildDisplay: "self" }),
        "parent-slug"
      )
    ).toBeNull();
  });

  it("returns null when LOCAL_OFFICE resolves to 'both' (office is canonical)", () => {
    // 'both' renders the office page; brand link shown alongside in UI.
    expect(
      canonicalParentSlugFor(
        vendor({
          role: "LOCAL_OFFICE",
          brandParentVendorId: "p1",
          displayMode: "inherit",
        }),
        parent({ defaultChildDisplay: "both" }),
        "parent-slug"
      )
    ).toBeNull();
  });

  it("returns brand slug when LOCAL_OFFICE resolves to 'brand_parent' via parent default", () => {
    expect(
      canonicalParentSlugFor(
        vendor({
          role: "LOCAL_OFFICE",
          brandParentVendorId: "p1",
          displayMode: "inherit",
        }),
        parent({ defaultChildDisplay: "brand_parent" }),
        "renewal-by-andersen"
      )
    ).toBe("renewal-by-andersen");
  });

  it("returns brand slug when LOCAL_OFFICE resolves to 'brand_parent' via child override", () => {
    expect(
      canonicalParentSlugFor(
        vendor({
          role: "LOCAL_OFFICE",
          brandParentVendorId: "p1",
          displayOverridePermitted: true,
          displayMode: "brand_parent",
        }),
        parent({ defaultChildDisplay: "self" }),
        "leaffilter"
      )
    ).toBe("leaffilter");
  });

  it("returns operator slug when LOCAL_OFFICE resolves to 'operator_parent' via child override", () => {
    expect(
      canonicalParentSlugFor(
        vendor({
          role: "LOCAL_OFFICE",
          brandParentVendorId: "p1",
          operatorParentVendorId: "op1",
          displayOverridePermitted: true,
          displayMode: "operator_parent",
        }),
        parent({ defaultChildDisplay: "self" }),
        "renewal-by-andersen",
        "esler-companies"
      )
    ).toBe("esler-companies");
  });

  it("returns null when 'brand_parent' resolves but brand slug not provided", () => {
    // Defensive — without the slug we can't emit a useful canonical, so don't.
    expect(
      canonicalParentSlugFor(
        vendor({
          role: "LOCAL_OFFICE",
          brandParentVendorId: "p1",
          displayMode: "inherit",
        }),
        parent({ defaultChildDisplay: "brand_parent" }),
        null
      )
    ).toBeNull();
  });
});
