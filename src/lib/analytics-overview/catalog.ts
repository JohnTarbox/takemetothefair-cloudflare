/**
 * Catalog domain loaders: total/new-in-window counts across events, venues,
 * and vendors, plus the Enhanced-Profile revenue card.
 */

import { and, count, eq, gte, lt } from "drizzle-orm";
import { events, vendors, venues } from "@/lib/db/schema";
import { trendOf, type Db } from "./shared";
import {
  ENHANCED_PROFILE_PRICE_USD,
  type CatalogGrowthCard,
  type EnhancedProfileRevenueCard,
} from "./types";

export async function loadCatalogGrowth(
  db: Db,
  sinceDate: Date,
  priorStartDate: Date,
  priorEndDate: Date,
  days: number
): Promise<CatalogGrowthCard> {
  const [
    eventsTotal,
    venuesTotal,
    vendorsTotal,
    eventsNew,
    venuesNew,
    vendorsNew,
    eventsPrior,
    venuesPrior,
    vendorsPrior,
  ] = await Promise.all([
    db.select({ c: count() }).from(events).where(eq(events.status, "APPROVED")),
    db.select({ c: count() }).from(venues),
    db.select({ c: count() }).from(vendors),
    db
      .select({ c: count() })
      .from(events)
      .where(and(eq(events.status, "APPROVED"), gte(events.createdAt, sinceDate))),
    db.select({ c: count() }).from(venues).where(gte(venues.createdAt, sinceDate)),
    db.select({ c: count() }).from(vendors).where(gte(vendors.createdAt, sinceDate)),
    db
      .select({ c: count() })
      .from(events)
      .where(
        and(
          eq(events.status, "APPROVED"),
          gte(events.createdAt, priorStartDate),
          lt(events.createdAt, priorEndDate)
        )
      ),
    db
      .select({ c: count() })
      .from(venues)
      .where(and(gte(venues.createdAt, priorStartDate), lt(venues.createdAt, priorEndDate))),
    db
      .select({ c: count() })
      .from(vendors)
      .where(and(gte(vendors.createdAt, priorStartDate), lt(vendors.createdAt, priorEndDate))),
  ]);

  const totals = {
    events: eventsTotal[0]?.c ?? 0,
    venues: venuesTotal[0]?.c ?? 0,
    vendors: vendorsTotal[0]?.c ?? 0,
  };
  const newInWindow = (eventsNew[0]?.c ?? 0) + (venuesNew[0]?.c ?? 0) + (vendorsNew[0]?.c ?? 0);
  const newInPriorWindow =
    (eventsPrior[0]?.c ?? 0) + (venuesPrior[0]?.c ?? 0) + (vendorsPrior[0]?.c ?? 0);

  return {
    totals: { ...totals, total: totals.events + totals.venues + totals.vendors },
    newInWindow,
    newInPriorWindow,
    trend: trendOf(newInWindow, newInPriorWindow),
    windowDays: days,
  };
}

export async function loadEnhancedProfileRevenue(
  db: Db,
  sinceDate: Date,
  priorStartDate: Date,
  priorEndDate: Date,
  days: number
): Promise<EnhancedProfileRevenueCard> {
  const [paying, newRows, priorRows] = await Promise.all([
    db.select({ c: count() }).from(vendors).where(eq(vendors.enhancedProfile, true)),
    db
      .select({ c: count() })
      .from(vendors)
      .where(
        and(eq(vendors.enhancedProfile, true), gte(vendors.enhancedProfileStartedAt, sinceDate))
      ),
    db
      .select({ c: count() })
      .from(vendors)
      .where(
        and(
          eq(vendors.enhancedProfile, true),
          gte(vendors.enhancedProfileStartedAt, priorStartDate),
          lt(vendors.enhancedProfileStartedAt, priorEndDate)
        )
      ),
  ]);
  const payingVendors = paying[0]?.c ?? 0;
  const newInWindow = newRows[0]?.c ?? 0;
  const newInPriorWindow = priorRows[0]?.c ?? 0;
  return {
    payingVendors,
    annualizedUsd: payingVendors * ENHANCED_PROFILE_PRICE_USD,
    newInWindow,
    newInPriorWindow,
    trend: trendOf(newInWindow, newInPriorWindow),
    windowDays: days,
  };
}
