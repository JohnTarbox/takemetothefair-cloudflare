/**
 * Unclaimed vendors with an upcoming confirmed event AND a contact_email on
 * file. These are the highest-leverage claim-outreach targets: they're
 * actively participating in events soon (timeliness signal) and we have a
 * direct line to the business (reachability).
 *
 * Repurposed 2026-05-25. The prior rule filtered on "no logo" + upcoming
 * event + no Enhanced Profile, which is broken: 99.8% of vendors have no
 * logo (the filter is a tautology) and the implied Enhanced Profile
 * activation path doesn't exist for unclaimed vendors — they have to claim
 * first. New shape: unclaimed + upcoming event + reachable, which IS the
 * claim-outreach funnel. Re-tiered out of T1 revenue (the action surfaces
 * outreach, not direct revenue) — defaults to T3 via tiers.ts omission.
 *
 * Coexists with standards_eligible_for_claim_outreach (which prioritizes by
 * profile completeness via linked-user email) — this rule prioritizes by
 * upcoming-event participation, which is a different timing signal.
 */

import { and, eq, gt, isNull, ne, or } from "drizzle-orm";
import { eventVendors, events, vendors } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

export const enhancedProfileCohortRule: RuleDefinition = {
  ruleKey: "enhanced_profile_cohort",
  title: "Reachable unclaimed vendors with upcoming events",
  rationaleTemplate:
    "{n} unclaimed vendors are confirmed at upcoming events and have a contact_email on file. Outreach now — while they're actively participating — converts the claim, which unlocks the Enhanced Profile upsell.",
  severity: "yellow",
  category: "outreach",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    // Two queries + in-memory intersection. inArray() against ~260 ids
    // would exceed D1's 100-parameter cap; the upcoming set is small
    // enough to hash-join in JS.
    const upcomingRows = await db
      .selectDistinct({ vendorId: eventVendors.vendorId })
      .from(eventVendors)
      .innerJoin(events, eq(eventVendors.eventId, events.id))
      .where(and(eq(events.status, "APPROVED"), gt(events.startDate, new Date())));
    const upcomingIds = new Set(
      upcomingRows.map((r) => r.vendorId).filter((id): id is string => id != null)
    );
    if (upcomingIds.size === 0) return [];

    // Reachable + unclaimed + not deleted. contact_email is the dedicated
    // outreach field (distinct from the linked-user email — a vendor row
    // can be unclaimed but still have a contact_email from prior intake).
    const candidates = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        slug: vendors.slug,
        vendorType: vendors.vendorType,
        city: vendors.city,
        state: vendors.state,
        contactEmail: vendors.contactEmail,
      })
      .from(vendors)
      .where(
        and(
          eq(vendors.claimed, false),
          isNull(vendors.deletedAt),
          or(ne(vendors.contactEmail, ""), isNull(vendors.contactEmail))
        )
      );

    return candidates
      .filter((c) => upcomingIds.has(c.id) && c.contactEmail && c.contactEmail.trim().length > 0)
      .map((r) => ({
        targetType: "vendor",
        targetId: r.id,
        payload: {
          businessName: r.businessName,
          slug: r.slug,
          vendorType: r.vendorType,
          location: [r.city, r.state].filter(Boolean).join(", "),
          outreachEmail: r.contactEmail,
        },
      }));
  },
};
