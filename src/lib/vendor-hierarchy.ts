/**
 * EH1 Phase 1 — vendor display resolution + alias chain.
 *
 * The relationship-model version of the original 0106 minimal resolver.
 * Implements spec §4 of Dev-Spec-Vendor-Hierarchy-Phase1-2026-06-04.md:
 *
 *   resolveDisplay(v):
 *     1. v = resolveAlias(v)       — follow alias chain to terminal canonical
 *     2. if v.brandParent is null: → 'self'
 *     3. if override granted + mode != inherit: → mode
 *     4. else → parent.defaultChildDisplay ?? 'self'
 *
 * Truth vs display: the resolver decides PRESENTATION only. The
 * event_vendors table always points at the office (the truth layer);
 * toggling display policy never re-points associations.
 *
 * Parent's-gate-always-wins (spec §4.4): a vendor claim grants edit
 * rights on the office row but does NOT change displayOverridePermitted
 * and does NOT bypass the gate. Only admin or the brand-parent owner
 * can flip the gate, via set_vendor_display_policy.
 *
 * Pure functions. No I/O. The caller is responsible for loading the
 * vendor + optional parents + (for alias chains) providing a lookup.
 */

export type ResolvedDisplay = "self" | "brand_parent" | "operator_parent" | "both";

export interface DisplayableVendor {
  role: "NATIONAL" | "LOCAL_OFFICE" | "INDEPENDENT";
  brandParentVendorId: string | null;
  operatorParentVendorId: string | null;
  aliasOfVendorId: string | null;
  displayOverridePermitted: boolean;
  displayMode: "inherit" | "self" | "brand_parent" | "operator_parent" | "both" | null;
}

export interface DisplayableParent {
  id: string;
  role: "NATIONAL" | "LOCAL_OFFICE" | "INDEPENDENT";
  defaultChildDisplay: "self" | "brand_parent" | "both" | null;
}

/** Cap on alias-chain depth — matches the cap suggested in design-doc
 *  open-Q2. Five hops is far beyond any plausible legitimate chain;
 *  it's the cycle guard, not a soft limit. */
const ALIAS_CHAIN_MAX_DEPTH = 5;

/**
 * Follow `aliasOfVendorId` to the terminal canonical row, cycle-guarded.
 *
 * @param v       — the starting vendor row
 * @param lookup  — caller-supplied `(id) => DisplayableVendor | null`;
 *                  return null when the id doesn't resolve (deleted row,
 *                  unknown id, etc.)
 * @returns       — the terminal canonical (the first row whose
 *                  aliasOfVendorId is null), or the deepest reachable
 *                  row if the chain terminates in a dangling FK.
 *                  Throws on cycle or depth-exceeded — these are data
 *                  bugs and silently swallowing them would be a worse
 *                  failure mode than a 500.
 */
export function resolveAlias(
  v: DisplayableVendor,
  lookup: (id: string) => DisplayableVendor | null
): DisplayableVendor {
  let cursor: DisplayableVendor = v;
  const visited = new Set<string>();

  for (let depth = 0; depth < ALIAS_CHAIN_MAX_DEPTH; depth++) {
    if (cursor.aliasOfVendorId == null) return cursor;
    // The terminal canonical's own id isn't in our DisplayableVendor
    // shape (callers pass it implicitly by passing `v` whose id they
    // know). We dedupe via the *target* ids in `visited` — any time we
    // try to follow into an id we've already followed into, that's a
    // cycle.
    if (visited.has(cursor.aliasOfVendorId)) {
      throw new Error(
        `resolveAlias: alias cycle detected (revisited target id ${cursor.aliasOfVendorId})`
      );
    }
    visited.add(cursor.aliasOfVendorId);
    const next = lookup(cursor.aliasOfVendorId);
    // Dangling FK — the alias points at an unknown / deleted row.
    // Stop here and return the deepest *known* row; this is the safer
    // user-facing behavior than throwing (renders the dangling row's
    // own page).
    if (next == null) return cursor;
    cursor = next;
  }

  throw new Error(`resolveAlias: alias chain exceeded depth ${ALIAS_CHAIN_MAX_DEPTH}`);
}

/**
 * Resolve which display surface to render for a vendor.
 *
 * @param vendor — the vendor row whose page is being requested. CALLERS
 *                 are responsible for running this through resolveAlias
 *                 first if they want alias transparency at render time;
 *                 this function only handles parent/preference logic.
 * @param brandParent — the brand-parent row, when vendor.brandParentVendorId
 *                 is set. Without it, LOCAL_OFFICE rows fall back to 'self'
 *                 (safe — renders the office page rather than collapsing
 *                 to a missing hub).
 * @returns 'self' | 'brand_parent' | 'operator_parent' | 'both'
 */
export function resolveVendorDisplay(
  vendor: DisplayableVendor,
  brandParent?: DisplayableParent | null
): ResolvedDisplay {
  // Spec §4 step 2: no brand parent → office is its own canonical.
  // Covers INDEPENDENT (no hierarchy) and the NATIONAL parent itself
  // (its own page is the hub). For LOCAL_OFFICE with no parent loaded,
  // fall back to 'self' — safer than collapsing to a missing brand.
  if (vendor.brandParentVendorId == null) return "self";
  if (!brandParent) return "self";

  // Spec §4 step 3: override path. Both conditions must be true:
  //   - the parent has explicitly granted the gate (displayOverridePermitted)
  //   - the office has picked a concrete mode (not 'inherit', not NULL)
  if (
    vendor.displayOverridePermitted &&
    vendor.displayMode != null &&
    vendor.displayMode !== "inherit"
  ) {
    return vendor.displayMode;
  }

  // Spec §4 step 4: inherit path — parent's defaultChildDisplay decides.
  // NULL falls back to 'self' (rare — only when the brand parent hasn't
  // set its policy yet; matches the 0106 LOCAL fallback semantics).
  return brandParent.defaultChildDisplay ?? "self";
}

/**
 * Helper for canonical-URL emission. When a LOCAL_OFFICE resolves to a
 * non-self mode, the canonical URL is the parent (brand or operator),
 * not the office page itself. The office page still EXISTS (operator
 * can still load it) but it rel="canonical"s up and is excluded from
 * the sitemap.
 *
 * Returns:
 *  - brandParentSlug when resolved display = 'brand_parent'
 *  - operatorParentSlug when resolved display = 'operator_parent'
 *  - null when resolved display = 'self' or 'both' (office is canonical;
 *    'both' renders the office page but also shows a brand link in the UI)
 *  - null when the relevant parent slug isn't loaded
 */
export function canonicalParentSlugFor(
  vendor: DisplayableVendor,
  brandParent?: DisplayableParent | null,
  brandParentSlug?: string | null,
  operatorParentSlug?: string | null
): string | null {
  if (vendor.role !== "LOCAL_OFFICE") return null;
  if (!brandParent) return null;
  const mode = resolveVendorDisplay(vendor, brandParent);
  if (mode === "brand_parent") return brandParentSlug ?? null;
  if (mode === "operator_parent") return operatorParentSlug ?? null;
  // 'self' and 'both' both render the office's own page as canonical.
  return null;
}
