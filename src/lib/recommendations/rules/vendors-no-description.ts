/**
 * Test rule that proves the engine end-to-end: surfaces vendors with no
 * description text. Cheap, defensible, and produces a non-zero result on most
 * production states. Replaces the proposal's Rule 3 (which was tied to the
 * past-events-as-APPROVED model — see plan file for context).
 */

import { eq, or, sql } from "drizzle-orm";
import { vendors } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

export const vendorsNoDescriptionRule: RuleDefinition = {
  ruleKey: "vendors_no_description",
  title: "Vendors with no description",
  rationaleTemplate:
    "{n} vendors have no description on file. Adding even a sentence improves SEO and helps event organizers evaluate them.",
  severity: "yellow",
  category: "data_quality",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    const rows = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        slug: vendors.slug,
      })
      .from(vendors)
      .where(or(sql`${vendors.description} IS NULL`, eq(vendors.description, "")));

    return rows.map((r) => ({
      targetType: "vendor",
      targetId: r.id,
      payload: {
        businessName: r.businessName,
        slug: r.slug,
      },
    }));
  },
};
