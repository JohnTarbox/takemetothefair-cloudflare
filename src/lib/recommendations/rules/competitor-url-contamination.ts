// Events or vendors whose ticket_url / website points at a competitor or
// aggregator domain instead of the operator's own page. Per §3.5 of the doc:
// "Competitor URL contamination — Two events linking to fairsandfestivals.net
// (a competitor's URL); not flagged."
//
// Currently the competitor list is hardcoded; a future improvement is to
// extract it into a `competitor_domains` D1 table per §10.2 of the doc.

import { sql } from "drizzle-orm";
import { events, vendors } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

const COMPETITOR_DOMAINS = [
  "fairsandfestivals.net",
  "festivalnet.com",
  "fairsandfestivals.com",
  "craftshowyellowpages.com",
];

export const competitorUrlContaminationRule: RuleDefinition = {
  ruleKey: "competitor_url_contamination",
  title: "Events/vendors linking to competitor or aggregator domains",
  rationaleTemplate:
    "{n} ticket_url or vendor.website fields point at competitor/aggregator domains (fairsandfestivals.net, etc.). Replace with the operator's direct URL or remove. Each contaminated link sends our visitor to a competitor.",
  severity: "yellow",
  category: "data_quality",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    if (COMPETITOR_DOMAINS.length === 0) return [];

    // Single OR predicate across all competitor domains, applied to both
    // events.ticket_url and vendors.website.
    const eventClauses = COMPETITOR_DOMAINS.map(
      (d) => sql`LOWER(${events.ticketUrl}) LIKE ${"%" + d.toLowerCase() + "%"}`
    ).reduce((acc, c) => sql`${acc} OR ${c}`);
    const vendorClauses = COMPETITOR_DOMAINS.map(
      (d) => sql`LOWER(${vendors.website}) LIKE ${"%" + d.toLowerCase() + "%"}`
    ).reduce((acc, c) => sql`${acc} OR ${c}`);

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
        .where(sql`${vendors.website} IS NOT NULL AND (${vendorClauses})`),
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
