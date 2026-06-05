import { describe, expect, it } from "vitest";
import {
  canonicalParentSlugIfHubResolved,
  resolveVendorDisplay,
  type DisplayableParent,
  type DisplayableVendor,
} from "../vendor-hierarchy";

// Helper builders — make the test bodies legible by stating only the
// fields that differ from the default-shape row.

function vendor(overrides: Partial<DisplayableVendor> = {}): DisplayableVendor {
  return {
    role: "INDEPENDENT",
    parentVendorId: null,
    defaultDisplay: null,
    overridePermitted: false,
    displayPreference: null,
    ...overrides,
  };
}

function parent(overrides: Partial<DisplayableParent> = {}): DisplayableParent {
  return {
    id: "parent-id",
    role: "NATIONAL",
    defaultDisplay: "LOCAL",
    ...overrides,
  };
}

describe("resolveVendorDisplay", () => {
  describe("trivial roles", () => {
    it("returns LOCAL for INDEPENDENT regardless of parent", () => {
      expect(resolveVendorDisplay(vendor({ role: "INDEPENDENT" }))).toBe("LOCAL");
      // A stray parent ref shouldn't change it — INDEPENDENT short-circuits.
      expect(resolveVendorDisplay(vendor({ role: "INDEPENDENT" }), parent())).toBe("LOCAL");
    });

    it("returns NATIONAL for NATIONAL", () => {
      expect(resolveVendorDisplay(vendor({ role: "NATIONAL", defaultDisplay: "LOCAL" }))).toBe(
        "NATIONAL"
      );
    });
  });

  describe("LOCAL_OFFICE — orphan/safety defaults", () => {
    it("falls back to LOCAL when parent is not provided", () => {
      expect(resolveVendorDisplay(vendor({ role: "LOCAL_OFFICE", parentVendorId: "p1" }))).toBe(
        "LOCAL"
      );
    });

    it("falls back to LOCAL when parent is null (DB miss)", () => {
      expect(
        resolveVendorDisplay(vendor({ role: "LOCAL_OFFICE", parentVendorId: "p1" }), null)
      ).toBe("LOCAL");
    });

    it("falls back to LOCAL when parent isn't actually NATIONAL", () => {
      // Data-quality safety net — if someone hand-set parent_vendor_id to a
      // non-NATIONAL row, we don't want the whole entity to disappear.
      expect(
        resolveVendorDisplay(
          vendor({ role: "LOCAL_OFFICE" }),
          parent({ role: "INDEPENDENT", defaultDisplay: "NATIONAL" })
        )
      ).toBe("LOCAL");
    });
  });

  describe("LOCAL_OFFICE — default path (no override)", () => {
    it("uses parent.default_display=LOCAL when child is INHERIT", () => {
      expect(
        resolveVendorDisplay(
          vendor({ role: "LOCAL_OFFICE", displayPreference: "INHERIT" }),
          parent({ defaultDisplay: "LOCAL" })
        )
      ).toBe("LOCAL");
    });

    it("uses parent.default_display=NATIONAL when child is INHERIT", () => {
      expect(
        resolveVendorDisplay(
          vendor({ role: "LOCAL_OFFICE", displayPreference: "INHERIT" }),
          parent({ defaultDisplay: "NATIONAL" })
        )
      ).toBe("NATIONAL");
    });

    it("ignores child preference when override_permitted=false", () => {
      // Parent gate closed — child says NATIONAL but parent says LOCAL.
      // Parent wins.
      expect(
        resolveVendorDisplay(
          vendor({
            role: "LOCAL_OFFICE",
            overridePermitted: false,
            displayPreference: "NATIONAL",
          }),
          parent({ defaultDisplay: "LOCAL" })
        )
      ).toBe("LOCAL");
    });

    it("falls back to LOCAL when parent.default_display is NULL", () => {
      // Phase 1 backfill left it unset — safe default rather than throwing.
      expect(
        resolveVendorDisplay(
          vendor({ role: "LOCAL_OFFICE", displayPreference: "INHERIT" }),
          parent({ defaultDisplay: null })
        )
      ).toBe("LOCAL");
    });
  });

  describe("LOCAL_OFFICE — override path", () => {
    it("uses child preference when gate=true and pref=NATIONAL", () => {
      expect(
        resolveVendorDisplay(
          vendor({
            role: "LOCAL_OFFICE",
            overridePermitted: true,
            displayPreference: "NATIONAL",
          }),
          parent({ defaultDisplay: "LOCAL" })
        )
      ).toBe("NATIONAL");
    });

    it("uses child preference when gate=true and pref=LOCAL", () => {
      expect(
        resolveVendorDisplay(
          vendor({
            role: "LOCAL_OFFICE",
            overridePermitted: true,
            displayPreference: "LOCAL",
          }),
          parent({ defaultDisplay: "NATIONAL" })
        )
      ).toBe("LOCAL");
    });

    it("falls through to parent default when gate=true but pref=INHERIT", () => {
      // INHERIT is the explicit "no override" — gate state irrelevant.
      expect(
        resolveVendorDisplay(
          vendor({
            role: "LOCAL_OFFICE",
            overridePermitted: true,
            displayPreference: "INHERIT",
          }),
          parent({ defaultDisplay: "NATIONAL" })
        )
      ).toBe("NATIONAL");
    });

    it("falls through to parent default when gate=true but pref=NULL", () => {
      expect(
        resolveVendorDisplay(
          vendor({
            role: "LOCAL_OFFICE",
            overridePermitted: true,
            displayPreference: null,
          }),
          parent({ defaultDisplay: "LOCAL" })
        )
      ).toBe("LOCAL");
    });
  });
});

describe("canonicalParentSlugIfHubResolved", () => {
  it("returns null for INDEPENDENT vendors", () => {
    expect(canonicalParentSlugIfHubResolved(vendor({ role: "INDEPENDENT" }))).toBeNull();
  });

  it("returns null for NATIONAL vendors", () => {
    expect(canonicalParentSlugIfHubResolved(vendor({ role: "NATIONAL" }))).toBeNull();
  });

  it("returns null when LOCAL_OFFICE resolves to LOCAL", () => {
    // The page IS its own canonical when it stays LOCAL.
    expect(
      canonicalParentSlugIfHubResolved(
        vendor({ role: "LOCAL_OFFICE", displayPreference: "INHERIT" }),
        parent({ defaultDisplay: "LOCAL" }),
        "parent-slug"
      )
    ).toBeNull();
  });

  it("returns parent slug when LOCAL_OFFICE resolves to NATIONAL via parent default", () => {
    expect(
      canonicalParentSlugIfHubResolved(
        vendor({ role: "LOCAL_OFFICE", displayPreference: "INHERIT" }),
        parent({ defaultDisplay: "NATIONAL" }),
        "renewal-by-andersen-national"
      )
    ).toBe("renewal-by-andersen-national");
  });

  it("returns parent slug when LOCAL_OFFICE resolves to NATIONAL via child override", () => {
    expect(
      canonicalParentSlugIfHubResolved(
        vendor({
          role: "LOCAL_OFFICE",
          overridePermitted: true,
          displayPreference: "NATIONAL",
        }),
        parent({ defaultDisplay: "LOCAL" }),
        "leaffilter-national"
      )
    ).toBe("leaffilter-national");
  });

  it("returns null when parent slug is missing even if display resolved to NATIONAL", () => {
    // Defensive — without the slug we can't emit a useful canonical, so don't.
    expect(
      canonicalParentSlugIfHubResolved(
        vendor({ role: "LOCAL_OFFICE", displayPreference: "INHERIT" }),
        parent({ defaultDisplay: "NATIONAL" }),
        null
      )
    ).toBeNull();
  });
});
