// STUB-tier vendors (event association exists, fails STANDARD criteria).
// Best-yield enrichment targets: AI description generation can pull from
// website + Google Places, getting them across the line into STANDARD.

import { sql, eq } from "drizzle-orm";
import { eventVendors, vendors } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

export const stubsReadyForEnrichmentRule: RuleDefinition = {
  ruleKey: "stubs_ready_for_enrichment",
  title: "Stub-tier vendors ready for AI enrichment",
  rationaleTemplate:
    "{n} vendors are STUB-tier (associated with at least one event but missing description, location, or website). AI-enriching them would graduate them to STANDARD and qualify them for the sitemap.",
  severity: "yellow",
  category: "data_quality",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    // Subquery: per-vendor event count.
    const eventCounts = db
      .select({
        vendorId: eventVendors.vendorId,
        n: sql<number>`COUNT(*)`.as("n"),
      })
      .from(eventVendors)
      .groupBy(eventVendors.vendorId)
      .as("ec");

    // STUB = enhancedProfile = false AND event_count > 0 AND NOT meets STANDARD.
    // STANDARD = description non-empty AND city+state non-empty AND
    //   (website non-empty OR social_links non-empty).
    const rows = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        slug: vendors.slug,
        hasWebsite: sql<number>`CASE WHEN TRIM(IFNULL(${vendors.website}, '')) != '' THEN 1 ELSE 0 END`,
      })
      .from(vendors)
      .innerJoin(eventCounts, eq(eventCounts.vendorId, vendors.id))
      .where(
        sql`${vendors.enhancedProfile} = 0
          AND ${vendors.deletedAt} IS NULL
          AND ${eventCounts.n} > 0
          AND NOT (
            TRIM(IFNULL(${vendors.description}, '')) != ''
            AND TRIM(IFNULL(${vendors.city}, '')) != ''
            AND TRIM(IFNULL(${vendors.state}, '')) != ''
            AND (
              TRIM(IFNULL(${vendors.website}, '')) != ''
              OR (${vendors.socialLinks} IS NOT NULL AND ${vendors.socialLinks} NOT IN ('', '{}'))
            )
          )`
      );

    return rows.map((r) => ({
      targetType: "vendor",
      targetId: r.id,
      payload: {
        businessName: r.businessName,
        slug: r.slug,
        hasWebsite: r.hasWebsite === 1,
      },
    }));
  },
};
