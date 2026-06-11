/**
 * Content domain loaders: blog coverage ratios and the recommendations
 * summary card (severity counts + actionable subset).
 */

import { count, eq, sql } from "drizzle-orm";
import { contentLinks, events, vendors, venues } from "@/lib/db/schema";
import { tierFor } from "@/lib/recommendations/tiers";
import { getActiveItems } from "@/lib/recommendations/engine";
import type { Db } from "./shared";
import type { BlogCoverageCard, RecommendationsSummaryCard } from "./types";

export async function loadBlogCoverage(db: Db): Promise<BlogCoverageCard> {
  // Mirrors the math used by /admin/coverage: an entity is "uncovered" when no
  // content_links row references it. Counts only APPROVED events to match the
  // denominator on the coverage page (uncovered + covered = approved set).
  const [
    eventTotalRows,
    vendorTotalRows,
    venueTotalRows,
    eventCoveredRows,
    vendorCoveredRows,
    venueCoveredRows,
  ] = await Promise.all([
    db.select({ c: count() }).from(events).where(eq(events.status, "APPROVED")),
    db.select({ c: count() }).from(vendors),
    db.select({ c: count() }).from(venues),
    db
      .select({ c: sql<number>`COUNT(DISTINCT ${contentLinks.targetId})` })
      .from(contentLinks)
      .where(eq(contentLinks.targetType, "EVENT")),
    db
      .select({ c: sql<number>`COUNT(DISTINCT ${contentLinks.targetId})` })
      .from(contentLinks)
      .where(eq(contentLinks.targetType, "VENDOR")),
    db
      .select({ c: sql<number>`COUNT(DISTINCT ${contentLinks.targetId})` })
      .from(contentLinks)
      .where(eq(contentLinks.targetType, "VENUE")),
  ]);

  const eventTotal = eventTotalRows[0]?.c ?? 0;
  const vendorTotal = vendorTotalRows[0]?.c ?? 0;
  const venueTotal = venueTotalRows[0]?.c ?? 0;
  const eventCovered = eventCoveredRows[0]?.c ?? 0;
  const vendorCovered = vendorCoveredRows[0]?.c ?? 0;
  const venueCovered = venueCoveredRows[0]?.c ?? 0;

  const eventsUncovered = Math.max(0, eventTotal - eventCovered);
  const vendorsUncovered = Math.max(0, vendorTotal - vendorCovered);
  const venuesUncovered = Math.max(0, venueTotal - venueCovered);

  return {
    events: { uncovered: eventsUncovered, total: eventTotal },
    vendors: { uncovered: vendorsUncovered, total: vendorTotal },
    venues: { uncovered: venuesUncovered, total: venueTotal },
    totalUncovered: eventsUncovered + vendorsUncovered + venuesUncovered,
    totalEntities: eventTotal + vendorTotal + venueTotal,
  };
}

export async function loadRecommendationsSummary(db: Db): Promise<RecommendationsSummaryCard> {
  // Reuses the same active-items query the Recommendations tab uses, so the
  // counts here always agree with what the admin sees on the tab.
  const items = await getActiveItems(db);
  let red = 0;
  let yellow = 0;
  let blue = 0;
  let actionable = 0;
  const ruleIds = new Set<string>();
  for (const it of items) {
    ruleIds.add(it.ruleId);
    if (it.severity === "red") {
      red++;
      actionable++;
    } else if (it.severity === "yellow") {
      yellow++;
      // T3 yellow = content-quality noise; T1/T2 yellow = high-impact.
      const tier = tierFor(it.ruleKey);
      if (tier === "T1" || tier === "T2") actionable++;
    } else if (it.severity === "blue") {
      blue++;
    }
  }
  const maxSeverity: "red" | "yellow" | "blue" | null =
    red > 0 ? "red" : yellow > 0 ? "yellow" : blue > 0 ? "blue" : null;
  return {
    totalItems: items.length,
    totalRules: ruleIds.size,
    maxSeverity,
    redCount: red,
    yellowCount: yellow,
    blueCount: blue,
    actionableCount: actionable,
  };
}
