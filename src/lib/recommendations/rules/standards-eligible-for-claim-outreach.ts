// STANDARD-tier vendors that haven't been claimed yet but have a linked
// user with a real email. These are the highest-yield claim-outreach
// targets — once claimed, they're a short upsell from Enhanced Profile.

import { sql, eq } from "drizzle-orm";
import { users, vendors } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

export const standardsEligibleForClaimOutreachRule: RuleDefinition = {
  ruleKey: "standards_eligible_for_claim_outreach",
  title: "STANDARD-tier vendors eligible for claim outreach",
  rationaleTemplate:
    "{n} STANDARD-tier vendors have a linked user account with email but haven't claimed their listing. Outreach to confirm ownership unlocks the Claimed badge and surfaces them for Enhanced Profile upsell.",
  severity: "yellow",
  category: "revenue",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    // STANDARD criteria + claimed = 0 + linked user has non-empty email.
    const rows = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        slug: vendors.slug,
        userEmail: users.email,
      })
      .from(vendors)
      .innerJoin(users, eq(vendors.userId, users.id))
      .where(
        sql`${vendors.claimed} = 0
          AND ${vendors.enhancedProfile} = 0
          AND TRIM(IFNULL(${users.email}, '')) != ''
          AND TRIM(IFNULL(${vendors.description}, '')) != ''
          AND TRIM(IFNULL(${vendors.city}, '')) != ''
          AND TRIM(IFNULL(${vendors.state}, '')) != ''
          AND (
            TRIM(IFNULL(${vendors.website}, '')) != ''
            OR (${vendors.socialLinks} IS NOT NULL AND ${vendors.socialLinks} NOT IN ('', '{}'))
          )`
      );

    return rows.map((r) => ({
      targetType: "vendor",
      targetId: r.id,
      payload: {
        businessName: r.businessName,
        slug: r.slug,
        outreachEmail: r.userEmail,
      },
    }));
  },
};
