/**
 * Vendors that are confirmed at upcoming events but haven't activated Enhanced
 * Profile and have no logo. These are the highest-leverage cohort candidates:
 * already engaged with the platform, missing visual identity, and would benefit
 * most from Enhanced Profile features.
 */

import { and, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { eventVendors, events, vendors } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

const RESULT_LIMIT = 25;

export const enhancedProfileCohortRule: RuleDefinition = {
  ruleKey: "enhanced_profile_cohort",
  title: "Activate Enhanced Profile for vendors with upcoming events and no logo",
  rationaleTemplate:
    "{n} vendors are confirmed at upcoming events but have no logo. Prime cohort candidates for Enhanced Profile activation.",
  severity: "yellow",
  category: "revenue",
  async run(db): Promise<ItemMatch[]> {
    // Two-step to keep the query readable: find approved-upcoming-event vendor ids,
    // then filter the vendors table by those ids + missing-logo + non-paying.
    const upcomingVendorIds = await db
      .selectDistinct({ vendorId: eventVendors.vendorId })
      .from(eventVendors)
      .innerJoin(events, eq(eventVendors.eventId, events.id))
      .where(and(eq(events.status, "APPROVED"), gt(events.startDate, new Date())));

    const ids = upcomingVendorIds.map((r) => r.vendorId);
    if (ids.length === 0) return [];

    const rows = await db
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
          inArray(vendors.id, ids),
          eq(vendors.enhancedProfile, false),
          or(isNull(vendors.logoUrl), eq(vendors.logoUrl, ""))
        )
      )
      .limit(RESULT_LIMIT);

    return rows.map((r) => ({
      targetType: "vendor",
      targetId: r.id,
      payload: {
        businessName: r.businessName,
        slug: r.slug,
        vendorType: r.vendorType,
        location: [r.city, r.state].filter(Boolean).join(", "),
      },
    }));

    // Suppress unused-import warnings for ne/sql (kept for future filter additions)
    void ne;
    void sql;
  },
};
