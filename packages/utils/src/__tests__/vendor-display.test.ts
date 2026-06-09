import { describe, expect, it } from "vitest";
import {
  displayVendorName,
  vendorSelfDisplayName,
  type ParentDisplayInput,
  type VendorDisplayInput,
} from "../vendor-display";

// Builders that mirror the vendor-hierarchy.test.ts pattern: state only the
// fields that differ from the default-shape row. Default = INDEPENDENT with
// no hierarchy + business_name set to a stable string.

function vendor(overrides: Partial<VendorDisplayInput> = {}): VendorDisplayInput {
  return {
    role: "INDEPENDENT",
    brandParentVendorId: null,
    operatorParentVendorId: null,
    aliasOfVendorId: null,
    displayOverridePermitted: false,
    displayMode: null,
    businessName: "Acme Co",
    displayName: null,
    ...overrides,
  };
}

function brand(overrides: Partial<ParentDisplayInput> = {}): ParentDisplayInput {
  return {
    id: "brand-id",
    role: "NATIONAL",
    defaultChildDisplay: "self",
    businessName: "BrandCo",
    displayName: null,
    ...overrides,
  };
}

describe("vendorSelfDisplayName", () => {
  it("returns business_name when display_name is null", () => {
    expect(vendorSelfDisplayName(vendor({ businessName: "Acme Co", displayName: null }))).toBe(
      "Acme Co"
    );
  });

  it("prefers display_name over business_name when set", () => {
    expect(vendorSelfDisplayName(vendor({ businessName: "Acme Inc", displayName: "Acme" }))).toBe(
      "Acme"
    );
  });

  it("falls back to business_name when display_name is empty/whitespace", () => {
    expect(vendorSelfDisplayName(vendor({ businessName: "Acme Co", displayName: "   " }))).toBe(
      "Acme Co"
    );
  });

  it("trims both fields", () => {
    expect(vendorSelfDisplayName(vendor({ businessName: "  Acme Co  ", displayName: null }))).toBe(
      "Acme Co"
    );
  });
});

describe("displayVendorName — INDEPENDENT (cache-key parity, ~99% of rows)", () => {
  it("returns business_name unchanged when display_name is null", () => {
    // The big invariant: for the INDEPENDENT case the string equals
    // business_name bit-for-bit, so no URL / no CDN derivative / no cache
    // key changes on the rollout.
    expect(displayVendorName(vendor({ role: "INDEPENDENT", businessName: "Joe's Diner" }))).toBe(
      "Joe's Diner"
    );
  });

  it("ignores brandParent for INDEPENDENT rows", () => {
    // Even if a parent is passed by accident, INDEPENDENT short-circuits.
    expect(
      displayVendorName(
        vendor({ role: "INDEPENDENT", businessName: "Joe's Diner" }),
        brand({ businessName: "OtherBrand" })
      )
    ).toBe("Joe's Diner");
  });

  it("honors display_name override for INDEPENDENT rows", () => {
    expect(
      displayVendorName(
        vendor({ role: "INDEPENDENT", businessName: "Joe's Diner LLC", displayName: "Joe's Diner" })
      )
    ).toBe("Joe's Diner");
  });
});

describe("displayVendorName — NATIONAL brand parent", () => {
  it("returns business_name for the brand row itself", () => {
    expect(
      displayVendorName(vendor({ role: "NATIONAL", businessName: "Renewal by Andersen" }))
    ).toBe("Renewal by Andersen");
  });

  it("honors display_name override on the brand row (§B1)", () => {
    // The marketing-name-vs-legal-name override case the spec calls out.
    expect(
      displayVendorName(
        vendor({
          role: "NATIONAL",
          businessName: "LeafFilter North LLC",
          displayName: "LeafFilter",
        })
      )
    ).toBe("LeafFilter");
  });
});

describe("displayVendorName — LOCAL_OFFICE under brand_parent-mode brand (LeafFilter shape)", () => {
  it("returns the BRAND's name when parent.defaultChildDisplay='brand_parent'", () => {
    // The §A repro: LeafFilter of Portland ME should render as "LeafFilter"
    // (the brand), not "LeafFilter of Portland, ME" (the office), because
    // the parent collapsed offices into the hub.
    expect(
      displayVendorName(
        vendor({
          role: "LOCAL_OFFICE",
          brandParentVendorId: "leaffilter-id",
          businessName: "LeafFilter of Portland, ME",
          displayMode: "inherit",
        }),
        brand({
          id: "leaffilter-id",
          businessName: "LeafFilter",
          defaultChildDisplay: "brand_parent",
        })
      )
    ).toBe("LeafFilter");
  });

  it("honors brand's display_name override when collapsing", () => {
    expect(
      displayVendorName(
        vendor({
          role: "LOCAL_OFFICE",
          brandParentVendorId: "leaffilter-id",
          businessName: "LeafFilter North of Massachusetts",
          displayMode: "inherit",
        }),
        brand({
          id: "leaffilter-id",
          businessName: "LeafFilter North LLC",
          displayName: "LeafFilter",
          defaultChildDisplay: "brand_parent",
        })
      )
    ).toBe("LeafFilter");
  });

  it("falls back to office self-name when brand isn't loaded (safety)", () => {
    // Caller skipped the brand JOIN — better to show "LeafFilter of Portland,
    // ME" than an empty string or 'undefined' on the public surface.
    expect(
      displayVendorName(
        vendor({
          role: "LOCAL_OFFICE",
          brandParentVendorId: "leaffilter-id",
          businessName: "LeafFilter of Portland, ME",
          displayMode: "inherit",
        })
        // brand omitted
      )
    ).toBe("LeafFilter of Portland, ME");
  });

  it("returns the office's OWN name when parent.defaultChildDisplay='self' (RbA shape)", () => {
    // RbA franchises are individually-rendered (default_child_display='self'),
    // so each franchise card shows its full franchise name, not "Renewal by
    // Andersen" collapsed.
    expect(
      displayVendorName(
        vendor({
          role: "LOCAL_OFFICE",
          brandParentVendorId: "rba-id",
          businessName: "Renewal by Andersen of Greater Maine",
          displayMode: "inherit",
        }),
        brand({
          id: "rba-id",
          businessName: "Renewal by Andersen",
          defaultChildDisplay: "self",
        })
      )
    ).toBe("Renewal by Andersen of Greater Maine");
  });
});

describe("displayVendorName — LOCAL_OFFICE override path (spec §4 step 3)", () => {
  it("honors child's 'self' override when gate granted (closes brand-parent default)", () => {
    // Parent default = brand_parent collapse, but THIS office opted out
    // via gate + 'self' mode. Office renders as its own name.
    expect(
      displayVendorName(
        vendor({
          role: "LOCAL_OFFICE",
          brandParentVendorId: "leaffilter-id",
          businessName: "LeafFilter Premium of Boston",
          displayOverridePermitted: true,
          displayMode: "self",
        }),
        brand({
          id: "leaffilter-id",
          businessName: "LeafFilter",
          defaultChildDisplay: "brand_parent",
        })
      )
    ).toBe("LeafFilter Premium of Boston");
  });

  it("returns operator name when child mode='operator_parent' and gate granted", () => {
    expect(
      displayVendorName(
        vendor({
          role: "LOCAL_OFFICE",
          brandParentVendorId: "rba-id",
          operatorParentVendorId: "esler-id",
          businessName: "Renewal by Andersen of Southern Maine & NH",
          displayOverridePermitted: true,
          displayMode: "operator_parent",
        }),
        brand({
          id: "rba-id",
          businessName: "Renewal by Andersen",
          defaultChildDisplay: "self",
        }),
        {
          id: "esler-id",
          role: "NATIONAL",
          defaultChildDisplay: null,
          businessName: "Esler Companies",
          displayName: null,
        }
      )
    ).toBe("Esler Companies");
  });

  it("falls back to office self-name when operator_parent mode resolves but operator not loaded", () => {
    expect(
      displayVendorName(
        vendor({
          role: "LOCAL_OFFICE",
          brandParentVendorId: "rba-id",
          operatorParentVendorId: "esler-id",
          businessName: "Renewal by Andersen of Southern Maine & NH",
          displayOverridePermitted: true,
          displayMode: "operator_parent",
        }),
        brand({
          id: "rba-id",
          businessName: "Renewal by Andersen",
          defaultChildDisplay: "self",
        })
        // operator omitted
      )
    ).toBe("Renewal by Andersen of Southern Maine & NH");
  });
});

describe("displayVendorName — 'both' composite (spec §C1)", () => {
  it("emits '<office> — <brand>' for the both-mode default", () => {
    // The §C1 worked example.
    expect(
      displayVendorName(
        vendor({
          role: "LOCAL_OFFICE",
          brandParentVendorId: "leafhome-id",
          businessName: "LeafFilter of Portland, ME",
          displayMode: "inherit",
        }),
        brand({
          id: "leafhome-id",
          businessName: "A Leaf Home Company",
          defaultChildDisplay: "both",
        })
      )
    ).toBe("LeafFilter of Portland, ME — A Leaf Home Company");
  });

  it("falls back to office-only when both-mode resolves but brand has no name", () => {
    expect(
      displayVendorName(
        vendor({
          role: "LOCAL_OFFICE",
          brandParentVendorId: "leafhome-id",
          businessName: "LeafFilter of Portland, ME",
          displayMode: "inherit",
        }),
        brand({
          id: "leafhome-id",
          businessName: "",
          displayName: null,
          defaultChildDisplay: "both",
        })
      )
    ).toBe("LeafFilter of Portland, ME");
  });
});

describe("displayVendorName — orphan / safety fallbacks", () => {
  it("returns office self-name when LOCAL_OFFICE has no brandParentVendorId", () => {
    expect(
      displayVendorName(
        vendor({
          role: "LOCAL_OFFICE",
          brandParentVendorId: null,
          businessName: "Orphaned Office",
        })
      )
    ).toBe("Orphaned Office");
  });

  it("returns office self-name when LOCAL_OFFICE's parent ref is null (DB miss)", () => {
    expect(
      displayVendorName(
        vendor({
          role: "LOCAL_OFFICE",
          brandParentVendorId: "p1",
          businessName: "Office With Dangling FK",
        }),
        null
      )
    ).toBe("Office With Dangling FK");
  });
});
