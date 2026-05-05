// Claimed vendors who are NOT yet on Enhanced Profile and rank in the
// top decile by view count. Per §6.6 strategy doc — these are the
// highest-yield Enhanced Profile upsell targets.
//
// Decile semantics:
// - Candidate set = vendors where claimed=1 AND enhancedProfile=0 AND view_count > 0
// - Threshold = view_count of the row at index ceil(N * 0.1) - 1 in DESC order
// - Returned set = all candidates with view_count >= threshold (handles ties)
// - When N < 10, returns the whole candidate set (no decile to compute)
// - When all view_counts are 0 (e.g., immediately post-deploy), returns empty

import { sql, and, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { eventVendors, vendors } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

const MIN_CANDIDATE_COUNT_FOR_DECILE = 10;

/**
 * Compute the inclusive view-count threshold for the top decile.
 * Caller passes view counts in DESC order. Returns the threshold;
 * caller filters candidates with view_count >= threshold (handles ties).
 *
 * - Empty input → 0 (caller's filter on view_count > 0 already excludes all)
 * - N < 10 → smallest view_count (return all candidates)
 * - N >= 10 → view_count at index ceil(N * 0.1) - 1
 */
export function computeTopDecileThreshold(viewCountsDesc: readonly number[]): number {
  if (viewCountsDesc.length === 0) return 0;
  if (viewCountsDesc.length < MIN_CANDIDATE_COUNT_FOR_DECILE) {
    return viewCountsDesc[viewCountsDesc.length - 1];
  }
  const decileIndex = Math.ceil(viewCountsDesc.length * 0.1) - 1;
  return viewCountsDesc[decileIndex];
}

export const claimedReadyForEnhancedUpsellRule: RuleDefinition = {
  ruleKey: "claimed_ready_for_enhanced_upsell",
  title: "Claimed vendors ready for Enhanced Profile upsell",
  rationaleTemplate:
    "{n} claimed vendors rank in the top 10% by page views and have not yet upgraded to Enhanced Profile. Highest-yield upsell cohort.",
  severity: "yellow",
  category: "revenue",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    // Fetch all candidates ordered by view_count desc; we'll compute the
    // decile threshold in TS rather than via SQL OFFSET (cleaner for the
    // tied-at-threshold case and the small-N fallback).
    const candidates = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        slug: vendors.slug,
        viewCount: vendors.viewCount,
      })
      .from(vendors)
      .where(
        and(
          eq(vendors.claimed, true),
          eq(vendors.enhancedProfile, false),
          gt(vendors.viewCount, 0),
          isNull(vendors.deletedAt)
        )
      )
      .orderBy(sql`${vendors.viewCount} DESC`);

    if (candidates.length === 0) return [];

    const threshold = computeTopDecileThreshold(candidates.map((c) => c.viewCount));

    // Pull per-vendor event counts for the payload (operator may want to see
    // both signals when triaging). Single GROUP BY query, joined in memory.
    const eventCounts = await db
      .select({
        vendorId: eventVendors.vendorId,
        n: sql<number>`COUNT(*)`,
      })
      .from(eventVendors)
      .where(isNotNull(eventVendors.vendorId))
      .groupBy(eventVendors.vendorId);
    const eventCountByVendor = new Map(eventCounts.map((r) => [r.vendorId, Number(r.n)]));

    return candidates
      .filter((c) => c.viewCount >= threshold)
      .map((c) => ({
        targetType: "vendor",
        targetId: c.id,
        payload: {
          businessName: c.businessName,
          slug: c.slug,
          viewCount: c.viewCount,
          eventCount: eventCountByVendor.get(c.id) ?? 0,
        },
      }));
  },
};
