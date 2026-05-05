// Claimed vendors who are NOT yet on Enhanced Profile but show high
// engagement (event association count is the proxy — vendors at multiple
// events are higher-value upsell targets). The doc proposed "top decile
// by view count" but vendors don't have view_count today; event_count is
// the closest proxy and is meaningful (an active vendor at 5+ events
// values visibility more than a one-event vendor).

import { sql, eq } from "drizzle-orm";
import { eventVendors, vendors } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

const HIGH_ENGAGEMENT_THRESHOLD = 3;

export const claimedReadyForEnhancedUpsellRule: RuleDefinition = {
  ruleKey: "claimed_ready_for_enhanced_upsell",
  title: "Claimed vendors ready for Enhanced Profile upsell",
  rationaleTemplate: `{n} vendors have claimed their listing but haven't upgraded to Enhanced Profile, and are at ${HIGH_ENGAGEMENT_THRESHOLD}+ events (high engagement). Best-yield upsell cohort.`,
  severity: "yellow",
  category: "revenue",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    const eventCounts = db
      .select({
        vendorId: eventVendors.vendorId,
        n: sql<number>`COUNT(*)`.as("n"),
      })
      .from(eventVendors)
      .groupBy(eventVendors.vendorId)
      .as("ec");

    const rows = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        slug: vendors.slug,
        eventCount: eventCounts.n,
      })
      .from(vendors)
      .innerJoin(eventCounts, eq(eventCounts.vendorId, vendors.id))
      .where(
        sql`${vendors.claimed} = 1
          AND ${vendors.enhancedProfile} = 0
          AND ${eventCounts.n} >= ${HIGH_ENGAGEMENT_THRESHOLD}`
      );

    return rows.map((r) => ({
      targetType: "vendor",
      targetId: r.id,
      payload: {
        businessName: r.businessName,
        slug: r.slug,
        eventCount: r.eventCount,
      },
    }));
  },
};
