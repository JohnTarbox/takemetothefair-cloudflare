/**
 * EH2.2 (Dev-Email-2026-06-09-EH2.md §C2) — /vendors listing brand-parent
 * collapse.
 *
 * The /vendors listing renders one card per "display group," where a group
 * is keyed by `COALESCE(brand_parent_vendor_id, id)`. For each group:
 *
 *   - `brand_parent`-mode brand → ONE card showing the brand (hub link),
 *     aggregating the offices' upcoming events. Drop the synthetic per-
 *     office cards from this view.
 *
 *   - `self`-mode brand → N franchise cards as today (one per LOCAL_OFFICE).
 *     The brand hub itself does NOT render as a separate card in the
 *     listing (its noindex posture extends to "don't dilute listing
 *     surface with it").
 *
 *   - `both`-mode brand → treated like `self` for v1. The composite
 *     office-and-brand name renders on the office card via
 *     `displayVendorName('both' mode)`, and the brand hub does NOT render
 *     as a separate listing card (the office IS the canonical surface).
 *
 *   - INDEPENDENT vendors → unchanged.
 *
 * Pure function. The caller owns DB I/O — passes in the match set
 * (already filtered by the user's `?q=` / `?type=` filters), the lookup
 * map for brand parent rows (which the caller batch-fetches), and the
 * per-vendor events map (likewise batch-fetched).
 *
 * Why a pure helper rather than inline? The grouping rule is exactly
 * the kind of logic that's hard to test in-page (would require either
 * an integration test or a lot of D1 mocking). Pulling it out lets us
 * cover every branch with table-driven cases in src/lib/__tests__/.
 */

import type { DisplayableVendor } from "@takemetothefair/utils";

/**
 * Minimal vendor row shape needed by the grouping rule. Wider than the
 * resolver's `DisplayableVendor` because the rule needs `id` (to look up
 * brand parent rows + dedup) and `defaultChildDisplay` (to decide whether
 * a NATIONAL row promotes to a collapsed brand card).
 */
export interface GroupableVendor extends DisplayableVendor {
  id: string;
  defaultChildDisplay: "self" | "brand_parent" | "both" | null;
}

/**
 * Output: each entry describes ONE card to render.
 *
 *   - `vendorId`: which row to render as the card's primary surface.
 *     For brand-collapsed groups this is the brand's id; for everything
 *     else it's the row's own id.
 *   - `aggregatedEventVendorIds`: the set of vendor ids whose events
 *     should be SUMMED into this card. For brand-collapsed cards this
 *     is the brand id + all of its offices; for non-collapsed cards
 *     it's just the row's own id.
 *   - `isBrandCollapsed`: true when the card represents a collapsed
 *     brand-parent-mode group (one card representing many offices).
 *     Useful for downstream "this card aggregates N offices" hints.
 */
export interface VendorListingCard {
  vendorId: string;
  aggregatedEventVendorIds: string[];
  isBrandCollapsed: boolean;
}

export interface GroupVendorListingInput {
  /**
   * Vendor rows matching the user's `?q=` / `?type=` filter, in display
   * order. These are the ROWS the caller initially fetched; the grouping
   * step may drop some (self-mode brand hubs in the match set) and may
   * promote others (offices folded into a brand-collapsed card).
   */
  matchedVendors: GroupableVendor[];
  /**
   * Brand parent rows referenced by any LOCAL_OFFICE in `matchedVendors`,
   * keyed by id. May include brand rows not in the match set (when the
   * user searched for an office whose brand was not itself matched).
   */
  brandParentsById: Map<string, GroupableVendor>;
  /**
   * For any brand whose group COULD collapse (brand-parent-mode), the
   * complete list of its LOCAL_OFFICE children. Used both for event
   * aggregation and to suppress per-office cards that didn't make the
   * match set but belong to a collapsed brand (defensive — caller can
   * pass an empty map when nothing collapses).
   */
  officesByBrandId: Map<string, GroupableVendor[]>;
}

/**
 * Apply the spec §C2 grouping rule to a list of matched vendor rows.
 *
 * Output is in INPUT ORDER, except:
 *   - When a LOCAL_OFFICE row would promote to a brand-collapsed card,
 *     the FIRST such office's position determines where the brand card
 *     lands. Subsequent offices in the same brand are dropped.
 *   - When a brand-mode NATIONAL row appears in the match set AND one
 *     of its offices also appeared earlier, the brand card lands at
 *     the office's position (since dedup happens on first sight). This
 *     matches the alphabetic-by-business_name expectation: brand
 *     "LeafFilter" sorts under "L", and so does "LeafFilter of Portland"
 *     — either ordering puts the result under L.
 */
export function groupVendorsForListing(input: GroupVendorListingInput): VendorListingCard[] {
  const { matchedVendors, brandParentsById, officesByBrandId } = input;

  // First pass — decide which brand ids "win" as collapsed cards.
  //
  // v1 lock-in: a brand collapses iff brand.defaultChildDisplay='brand_parent'
  // AND at least one row in the match set references it (either the brand
  // itself, or one of its offices). Per-office overrides
  // (displayOverridePermitted=true + displayMode='self') are honored on the
  // OFFICE DETAIL PAGE via displayVendorName's gate, but they DON'T fragment
  // the listing — a brand that opted into collapse renders ONE listing card
  // regardless of how many of its offices opted out individually.
  // Rationale: the listing is a "discover brands" surface; the per-office
  // gate exists to fix specific office detail pages, not to fragment
  // browsing UX. If a brand really wants offices listed separately, it
  // sets default_child_display='self' (the global toggle).
  const collapsedBrandIds = new Set<string>();
  for (const v of matchedVendors) {
    if (v.role === "NATIONAL" && v.defaultChildDisplay === "brand_parent") {
      collapsedBrandIds.add(v.id);
      continue;
    }
    if (v.role === "LOCAL_OFFICE" && v.brandParentVendorId) {
      const brand = brandParentsById.get(v.brandParentVendorId);
      if (brand && brand.defaultChildDisplay === "brand_parent") {
        collapsedBrandIds.add(brand.id);
      }
    }
  }

  // Second pass — emit cards. Use a Set to dedup brand-card emissions
  // (a brand with 6 matching offices emits ONE card, at the position
  // of the first office encountered).
  const emittedBrandIds = new Set<string>();
  const cards: VendorListingCard[] = [];

  for (const v of matchedVendors) {
    // INDEPENDENT — render as own card. (~99% of rows hit this branch.)
    if (v.role === "INDEPENDENT") {
      cards.push({
        vendorId: v.id,
        aggregatedEventVendorIds: [v.id],
        isBrandCollapsed: false,
      });
      continue;
    }

    // NATIONAL brand row.
    if (v.role === "NATIONAL") {
      if (collapsedBrandIds.has(v.id)) {
        // Brand-parent-mode brand promoted as a collapsed card.
        if (emittedBrandIds.has(v.id)) continue;
        emittedBrandIds.add(v.id);
        const officeIds = (officesByBrandId.get(v.id) ?? []).map((o) => o.id);
        cards.push({
          vendorId: v.id,
          // Aggregate events from the brand itself (rare but possible —
          // a brand-level event_vendors row) AND all of its offices.
          aggregatedEventVendorIds: [v.id, ...officeIds],
          isBrandCollapsed: true,
        });
      }
      // Self-mode or both-mode NATIONAL hub: DO NOT render in listing.
      // The brand hub page itself still exists at /vendors/<brand-slug>
      // for direct navigation (and admin paths / claim flows); it's
      // just suppressed from the listing surface so it doesn't compete
      // with the franchise cards.
      continue;
    }

    // LOCAL_OFFICE row.
    if (v.brandParentVendorId && collapsedBrandIds.has(v.brandParentVendorId)) {
      // Brand collapses → office folds into the brand card. Emit the
      // brand card here (at this office's position) if not already.
      if (emittedBrandIds.has(v.brandParentVendorId)) continue;
      emittedBrandIds.add(v.brandParentVendorId);
      const officeIds = (officesByBrandId.get(v.brandParentVendorId) ?? []).map((o) => o.id);
      cards.push({
        vendorId: v.brandParentVendorId,
        aggregatedEventVendorIds: [v.brandParentVendorId, ...officeIds],
        isBrandCollapsed: true,
      });
      continue;
    }

    // LOCAL_OFFICE under self/both/operator_parent mode → render its own
    // card. Event aggregation is row-level.
    cards.push({
      vendorId: v.id,
      aggregatedEventVendorIds: [v.id],
      isBrandCollapsed: false,
    });
  }

  return cards;
}

/**
 * Helper for callers that want to know which brand parent ids they
 * need to load given a match set. Returns the deduped set of brand_parent
 * ids referenced by any LOCAL_OFFICE in the input — caller batch-fetches
 * these rows + their offices, then calls `groupVendorsForListing`.
 */
export function collectBrandParentIdsToLoad(
  matchedVendors: Pick<GroupableVendor, "role" | "brandParentVendorId">[]
): string[] {
  const ids = new Set<string>();
  for (const v of matchedVendors) {
    if (v.role === "LOCAL_OFFICE" && v.brandParentVendorId) {
      ids.add(v.brandParentVendorId);
    }
  }
  return [...ids];
}
