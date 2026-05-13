/**
 * Vendors that are confirmed at upcoming events but haven't activated Enhanced
 * Profile and have no logo. These are the highest-leverage cohort candidates:
 * already engaged with the platform, missing visual identity, and would benefit
 * most from Enhanced Profile features.
 */

import { and, eq, gt, isNull, or } from "drizzle-orm";
import { eventVendors, events, vendors } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

export const enhancedProfileCohortRule: RuleDefinition = {
  ruleKey: "enhanced_profile_cohort",
  title: "Activate Enhanced Profile for vendors with upcoming events and no logo",
  rationaleTemplate:
    "{n} vendors are confirmed at upcoming events but have no logo. Prime cohort candidates for Enhanced Profile activation.",
  severity: "yellow",
  category: "revenue",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    // Two queries + in-memory intersection. We previously used inArray() on
    // the upcoming-vendor id set, but D1 caps SQL parameters at 100 and the
    // set is ~260 entries in production — every scan since the cohort grew
    // past 100 has thrown "D1_ERROR: too many SQL variables" (issue #149).
    //
    // The non-inArray filters narrow vendors to ~600 candidates today (no
    // enhanced profile + missing logo + not deleted); we hash-join against
    // the upcoming set in JS. Both halves are well within the 30s budget.
    const upcomingRows = await db
      .selectDistinct({ vendorId: eventVendors.vendorId })
      .from(eventVendors)
      .innerJoin(events, eq(eventVendors.eventId, events.id))
      .where(and(eq(events.status, "APPROVED"), gt(events.startDate, new Date())));
    const upcomingIds = new Set(
      upcomingRows.map((r) => r.vendorId).filter((id): id is string => id != null)
    );
    if (upcomingIds.size === 0) return [];

    const candidates = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        slug: vendors.slug,
        vendorType: vendors.vendorType,
        city: vendors.city,
        state: vendors.state,
      })
      .from(vendors)
      .where(
        and(
          eq(vendors.enhancedProfile, false),
          or(isNull(vendors.logoUrl), eq(vendors.logoUrl, "")),
          isNull(vendors.deletedAt)
        )
      );

    return candidates
      .filter((c) => upcomingIds.has(c.id))
      .map((r) => ({
        targetType: "vendor",
        targetId: r.id,
        payload: {
          businessName: r.businessName,
          slug: r.slug,
          vendorType: r.vendorType,
          location: [r.city, r.state].filter(Boolean).join(", "),
        },
      }));
  },
};
