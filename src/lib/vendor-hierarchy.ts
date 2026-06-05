/**
 * EH1 Phase 2 (2026-06-05) — vendor display resolution.
 *
 * Decides which "face" of a hierarchical vendor surfaces publicly:
 *
 *   - For role=INDEPENDENT vendors: always 'LOCAL' (no hierarchy, the
 *     vendor IS the public-facing entity).
 *   - For role=NATIONAL: always 'NATIONAL' (the hub).
 *   - For role=LOCAL_OFFICE: depends on the parent's policy + the
 *     child's preference + the parent's override gate. See
 *     resolveLocalOfficeDisplay below.
 *
 * The rule (John's 2026-06-03 decision, codified in
 * project_national_local_vendor_model.md):
 *
 *   if (override_permitted AND display_preference != 'INHERIT')
 *     → use child's display_preference
 *   else
 *     → use parent's default_display
 *
 * This means the parent's gate (`override_permitted`) wins by default —
 * a claimed office gets EDIT rights but doesn't bypass the gate. The
 * national brand decides whether local offices can self-route.
 *
 * Pure function. No I/O. Caller supplies the vendor row + (when
 * role=LOCAL_OFFICE) the parent vendor row already loaded. Returns
 * 'LOCAL' as the safe default in any ambiguous case (e.g. a
 * LOCAL_OFFICE row pointing at a parent that doesn't exist or whose
 * default_display is NULL — render the office page rather than
 * silently 404 the entire hierarchy).
 */

export type ResolvedDisplay = "NATIONAL" | "LOCAL";

export interface DisplayableVendor {
  role: "NATIONAL" | "LOCAL_OFFICE" | "INDEPENDENT";
  parentVendorId: string | null;
  defaultDisplay: "NATIONAL" | "LOCAL" | null;
  overridePermitted: boolean;
  displayPreference: "NATIONAL" | "LOCAL" | "INHERIT" | null;
}

export interface DisplayableParent {
  id: string;
  role: "NATIONAL" | "LOCAL_OFFICE" | "INDEPENDENT";
  defaultDisplay: "NATIONAL" | "LOCAL" | null;
}

/**
 * Resolve which display surface to render for a vendor.
 *
 * @param vendor — the vendor row whose page is being requested
 * @param parent — optional. The parent row, when vendor.role='LOCAL_OFFICE'.
 *                 Required for accurate LOCAL_OFFICE resolution; without it
 *                 the helper falls back to 'LOCAL' (safe — renders the
 *                 office page rather than collapsing to a missing hub).
 */
export function resolveVendorDisplay(
  vendor: DisplayableVendor,
  parent?: DisplayableParent | null
): ResolvedDisplay {
  if (vendor.role === "INDEPENDENT") return "LOCAL";
  if (vendor.role === "NATIONAL") return "NATIONAL";

  // role = 'LOCAL_OFFICE' below.
  // Without the parent row loaded, we can't apply the rule — safe default
  // is LOCAL (render the office page). This prevents a database-inconsistency
  // (orphaned LOCAL_OFFICE) from collapsing the whole entity.
  if (!parent || parent.role !== "NATIONAL") return "LOCAL";

  // Override path: parent must have explicitly granted the gate AND
  // the child must have set a concrete preference (not INHERIT).
  if (
    vendor.overridePermitted &&
    vendor.displayPreference &&
    vendor.displayPreference !== "INHERIT"
  ) {
    return vendor.displayPreference;
  }

  // Default path: parent's choice. NULL default_display falls back to LOCAL
  // (rare — only happens if Phase 1 backfill left it unset).
  return parent.defaultDisplay ?? "LOCAL";
}

/**
 * Helper for the canonical-URL emitter. When a LOCAL_OFFICE resolves
 * to NATIONAL, the public canonical URL is the parent hub — not the
 * office page itself. The office page still EXISTS (operator can
 * still load /vendors/<office-slug>) but it should rel="canonical" up
 * to the hub and be excluded from the sitemap.
 *
 * Returns null when the vendor is its own canonical (the common case).
 */
export function canonicalParentSlugIfHubResolved(
  vendor: DisplayableVendor,
  parent?: DisplayableParent | null,
  parentSlug?: string | null
): string | null {
  if (vendor.role !== "LOCAL_OFFICE") return null;
  if (!parent || !parentSlug) return null;
  const display = resolveVendorDisplay(vendor, parent);
  if (display !== "NATIONAL") return null;
  return parentSlug;
}
