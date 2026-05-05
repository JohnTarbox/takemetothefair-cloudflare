// Events or vendors whose ticket_url / website points at a competitor or
// aggregator domain instead of the operator's own page. Per §3.5 of the doc:
// "Competitor URL contamination — Two events linking to fairsandfestivals.net
// (a competitor's URL); not flagged."
//
// Domain list is loaded from the competitor_domains D1 table per §10.2; the
// previous hardcoded array was migrated by drizzle/0058 and can be edited
// via /api/admin/competitor-domains without a code deploy.

import { sql } from "drizzle-orm";
import { events, vendors } from "@/lib/db/schema";
import { loadCompetitorDomains } from "@/lib/competitor-domains";
import type { ItemMatch, RuleDefinition } from "../engine";

export const competitorUrlContaminationRule: RuleDefinition = {
  ruleKey: "competitor_url_contamination",
  title: "Events/vendors linking to competitor or aggregator domains",
  rationaleTemplate:
    "{n} ticket_url or vendor.website fields point at competitor/aggregator domains. Replace with the operator's direct URL or remove. Each contaminated link sends our visitor to a competitor.",
  severity: "yellow",
  category: "data_quality",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    const competitorList = await loadCompetitorDomains(db);
    if (competitorList.length === 0) return [];

    // Single OR predicate across all competitor domains, applied to both
    // events.ticket_url and vendors.website.
    const eventClauses = competitorList
      .map((d) => sql`LOWER(${events.ticketUrl}) LIKE ${"%" + d + "%"}`)
      .reduce((acc, c) => sql`${acc} OR ${c}`);
    const vendorClauses = competitorList
      .map((d) => sql`LOWER(${vendors.website}) LIKE ${"%" + d + "%"}`)
      .reduce((acc, c) => sql`${acc} OR ${c}`);

    const [eventRows, vendorRows] = await Promise.all([
      db
        .select({
          id: events.id,
          name: events.name,
          slug: events.slug,
          ticketUrl: events.ticketUrl,
        })
        .from(events)
        .where(sql`${events.ticketUrl} IS NOT NULL AND (${eventClauses})`),
      db
        .select({
          id: vendors.id,
          businessName: vendors.businessName,
          slug: vendors.slug,
          website: vendors.website,
        })
        .from(vendors)
        .where(
          sql`${vendors.website} IS NOT NULL AND ${vendors.deletedAt} IS NULL AND (${vendorClauses})`
        ),
    ]);

    const matches: ItemMatch[] = [
      ...eventRows.map((r) => ({
        targetType: "event",
        targetId: r.id,
        payload: {
          name: r.name,
          slug: r.slug,
          field: "ticket_url",
          contaminatedUrl: r.ticketUrl,
        },
      })),
      ...vendorRows.map((r) => ({
        targetType: "vendor",
        targetId: r.id,
        payload: {
          businessName: r.businessName,
          slug: r.slug,
          field: "website",
          contaminatedUrl: r.website,
        },
      })),
    ];

    return matches;
  },
};
