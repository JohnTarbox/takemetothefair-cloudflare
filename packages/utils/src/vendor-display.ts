/**
 * EH2.1 (2026-06-09) — vendor display-name helper.
 *
 * Render-time helper that composes resolveVendorDisplay + resolveAlias into
 * a single resolved name string. Mirrors the displayVenueName sweep shape
 * from PR #296/#298 — one helper, called at every name-surface render site.
 *
 * Decision matrix (matches Dev-Email-2026-06-09-EH2.md §B + §C1):
 *
 *   role = INDEPENDENT      → COALESCE(display_name, business_name)
 *   role = NATIONAL         → COALESCE(display_name, business_name)
 *   role = LOCAL_OFFICE
 *     mode = self           → COALESCE(display_name, business_name)
 *     mode = brand_parent   → COALESCE(brand.display_name, brand.business_name)
 *     mode = operator_parent → COALESCE(operator.display_name, operator.business_name)
 *     mode = both           → "<office_name> — <brand_name>" (em-dash composite)
 *
 * Cache-key parity:
 *   For the INDEPENDENT case (~99% of rows) the helper returns business_name
 *   unchanged — bit-identical to today's renders. URLs, R2/CDN derivatives,
 *   and rendered HTML cache keys stay stable. Only the LOCAL_OFFICE /
 *   NATIONAL cohort (hundreds of rows, not thousands) gets new strings.
 *
 * Safety defaults:
 *   When a LOCAL_OFFICE row has a non-self resolved mode but the relevant
 *   parent isn't loaded (caller skipped the JOIN), the helper falls back to
 *   the office's own name. Safer than emitting an empty string or a 'undefined'
 *   placeholder on the public surface.
 *
 * Alias resolution:
 *   Like resolveVendorDisplay, this is a pure function — alias-chain
 *   resolution is the caller's responsibility. Callers that want alias
 *   transparency run `resolveAlias(vendor, lookup)` first and pass the
 *   terminal canonical's row in.
 */

import {
  resolveVendorDisplay,
  type DisplayableParent,
  type DisplayableVendor,
} from "./vendor-hierarchy";

export interface VendorDisplayInput extends DisplayableVendor {
  /** Raw business_name column — the default surface when no override applies. */
  businessName: string;
  /** Optional override (EH2.1 drizzle/0121). Nullable; falls back to businessName. */
  displayName: string | null;
}

export interface ParentDisplayInput extends DisplayableParent {
  /** Brand-parent's business_name. */
  businessName: string;
  /** Brand-parent's display_name override (EH2.1 drizzle/0121). Nullable. */
  displayName: string | null;
}

/**
 * Inner: COALESCE(display_name, business_name) with whitespace trim. Exported
 * for callers that already know they want the raw "self" name without the
 * full gate evaluation (admin edit forms, audit log labels, etc.).
 */
export function vendorSelfDisplayName(vendor: VendorDisplayInput): string {
  const override = (vendor.displayName ?? "").trim();
  if (override.length > 0) return override;
  return (vendor.businessName ?? "").trim();
}

function parentSelfDisplayName(parent: ParentDisplayInput): string {
  const override = (parent.displayName ?? "").trim();
  if (override.length > 0) return override;
  return (parent.businessName ?? "").trim();
}

/**
 * Resolve the display-name string for a vendor row, honoring the
 * EH1 hierarchy gate.
 *
 * @param vendor — the vendor row whose name is being rendered.
 * @param brandParent — when vendor.role='LOCAL_OFFICE' and brandParentVendorId
 *                 is set, the brand-parent row. Without it, LOCAL_OFFICE rows
 *                 fall back to their own self-name (safe — never emits an
 *                 empty string or "undefined" on the public surface).
 * @param operatorParent — required only for the 'operator_parent' mode (rare —
 *                 today only the Esler-Companies operator-parent case uses it).
 *                 Without it, falls back to self-name.
 * @returns the resolved display string. Never empty (falls back to '' only
 *                 when the row itself has no business_name, which the schema
 *                 forbids — kept defensive).
 */
export function displayVendorName(
  vendor: VendorDisplayInput,
  brandParent?: ParentDisplayInput | null,
  operatorParent?: ParentDisplayInput | null
): string {
  const selfName = vendorSelfDisplayName(vendor);

  // Quick exits for cases that don't consult the gate.
  if (vendor.role === "INDEPENDENT") return selfName;
  if (vendor.role === "NATIONAL") return selfName;

  // LOCAL_OFFICE — run the resolver (handles orphan + missing-parent fallbacks).
  const mode = resolveVendorDisplay(vendor, brandParent);

  if (mode === "self") return selfName;

  if (mode === "brand_parent") {
    if (!brandParent) return selfName;
    const brandName = parentSelfDisplayName(brandParent);
    return brandName.length > 0 ? brandName : selfName;
  }

  if (mode === "operator_parent") {
    if (!operatorParent) return selfName;
    const opName = parentSelfDisplayName(operatorParent);
    return opName.length > 0 ? opName : selfName;
  }

  if (mode === "both") {
    // Composite "<office_name> — <brand_name>" per spec §C1 example
    // ("LeafFilter of Portland, ME — A Leaf Home Company"). When the
    // brand isn't loaded or has no usable name, fall back to office-only.
    if (!brandParent) return selfName;
    const brandName = parentSelfDisplayName(brandParent);
    return brandName.length > 0 ? `${selfName} — ${brandName}` : selfName;
  }

  return selfName;
}
