/**
 * Short / missing meta-description rules. Approximates Bing Site Scan's "meta
 * descriptions are too short" finding for the dynamic pages this app generates,
 * since BWT's manual Site Scan tool is UI-only and not exposed via their API
 * (see reference_bing_webmaster_api_gotchas memory).
 *
 * Threshold: SHORT_THRESHOLD chars. Bing's recommendation is 150–160 for the
 * meta description; below ~70 is "too short" territory. We pick 70 as a
 * conservative floor — a sentence-and-a-half. Pages above it might still be
 * suboptimal but aren't "broken" enough to flag here.
 *
 * Skipped: promoters. There's no public /promoters/[slug] route in this app
 * (project_no_public_promoter_page memory), so the description never feeds a
 * meta tag and isn't worth flagging.
 *
 * Complementary to vendors-no-description.ts: that rule covers NULL/empty;
 * these cover the "wrote something but it's too short" case.
 */

import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { events, vendors, venues } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

const SHORT_THRESHOLD = 70;

export const eventsShortDescriptionRule: RuleDefinition = {
  ruleKey: "events_short_description",
  title: "Events with short meta descriptions",
  rationaleTemplate:
    "{n} APPROVED events have a description shorter than 70 characters. Bing flags these as too short to provide context.",
  severity: "yellow",
  category: "seo",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    const rows = await db
      .select({
        id: events.id,
        name: events.name,
        slug: events.slug,
        len: sql<number>`LENGTH(${events.description})`,
      })
      .from(events)
      .where(
        and(
          eq(events.status, "APPROVED"),
          isNotNull(events.description),
          ne(events.description, ""),
          sql`LENGTH(${events.description}) < ${SHORT_THRESHOLD}`
        )
      );

    return rows.map((r) => ({
      targetType: "event",
      targetId: r.id,
      payload: {
        name: r.name,
        slug: r.slug,
        descriptionLength: r.len,
      },
    }));
  },
};

export const venuesShortDescriptionRule: RuleDefinition = {
  ruleKey: "venues_short_description",
  title: "Venues with short meta descriptions",
  rationaleTemplate:
    "{n} venues have a description shorter than 70 characters. Bing flags these as too short to provide context.",
  severity: "yellow",
  category: "seo",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    const rows = await db
      .select({
        id: venues.id,
        name: venues.name,
        slug: venues.slug,
        len: sql<number>`LENGTH(${venues.description})`,
      })
      .from(venues)
      .where(
        and(
          isNotNull(venues.description),
          ne(venues.description, ""),
          sql`LENGTH(${venues.description}) < ${SHORT_THRESHOLD}`
        )
      );

    return rows.map((r) => ({
      targetType: "venue",
      targetId: r.id,
      payload: {
        name: r.name,
        slug: r.slug,
        descriptionLength: r.len,
      },
    }));
  },
};

export const vendorsShortDescriptionRule: RuleDefinition = {
  ruleKey: "vendors_short_description",
  title: "Vendors with short meta descriptions",
  rationaleTemplate:
    "{n} vendors have a description shorter than 70 characters. Complement to vendors-no-description: these wrote something but it's too short.",
  severity: "yellow",
  category: "seo",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    const rows = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        slug: vendors.slug,
        len: sql<number>`LENGTH(${vendors.description})`,
      })
      .from(vendors)
      .where(
        and(
          isNotNull(vendors.description),
          ne(vendors.description, ""),
          sql`LENGTH(${vendors.description}) < ${SHORT_THRESHOLD}`
        )
      );

    return rows.map((r) => ({
      targetType: "vendor",
      targetId: r.id,
      payload: {
        businessName: r.businessName,
        slug: r.slug,
        descriptionLength: r.len,
      },
    }));
  },
};
