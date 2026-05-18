/**
 * Canonical-path classifier for the recommendations engine. Used by
 * scanAll() to drop GSC-derived rule items whose `topPagePath` points at
 * a slug that's no longer current (renamed event/venue/vendor/promoter/blog
 * post). Those paths still resolve via 301 redirect, so they're not broken
 * — they're just noise in the admin queue until Google recrawls.
 *
 * Conservative by design: only flags `"stale"` when the path matches the
 * exact `/events/{slug}` shape AND the slug doesn't exist in the live
 * entity table. State hubs (`/events/maine`), category hubs
 * (`/events/fairs`), and anything that doesn't match the entity-path
 * regex return `"unknown-pattern"` and are left alone.
 */

import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { blogPosts, events, promoters, vendors, venues } from "@/lib/db/schema";
import { isPublicEventStatus } from "@/lib/event-status";

type Db = DrizzleD1Database<typeof schema>;

export type PathClassification = "valid" | "stale" | "unknown-pattern";

// Mirrors HUB_PATH_PATTERNS in src/lib/recommendations/rules/cannibalization-detection.ts.
// Duplicated rather than imported because the cannibalization list is a
// regex array; turning it into a Set here keeps classification O(1) and
// the lists drift slowly enough that manual sync is cheaper than coupling.
const KNOWN_HUB_PATHS = new Set([
  "/events/maine",
  "/events/vermont",
  "/events/new-hampshire",
  "/events/massachusetts",
  "/events/connecticut",
  "/events/rhode-island",
  "/events/fairs",
  "/events/festivals",
  "/events/craft-shows",
  "/events/craft-fairs",
  "/events/markets",
  "/events/farmers-markets",
  "/vendors",
  "/venues",
]);

const ENTITY_PATH_RE = /^\/(events|venues|vendors|promoters|blog)\/([a-z0-9-]+)\/?$/;

export type SlugSets = {
  events: Set<string>;
  venues: Set<string>;
  vendors: Set<string>;
  promoters: Set<string>;
  blog: Set<string>;
};

export interface CanonicalPathChecker {
  classifyPath(path: string): PathClassification;
}

export function makeChecker(slugSets: SlugSets): CanonicalPathChecker {
  return {
    classifyPath(path: string): PathClassification {
      if (KNOWN_HUB_PATHS.has(path)) return "unknown-pattern";
      const m = path.match(ENTITY_PATH_RE);
      if (!m) return "unknown-pattern";
      const entityType = m[1] as keyof SlugSets;
      const slug = m[2];
      return slugSets[entityType].has(slug) ? "valid" : "stale";
    },
  };
}

export async function loadSlugSets(db: Db): Promise<SlugSets> {
  const [eventRows, venueRows, vendorRows, promoterRows, blogRows] = await Promise.all([
    db.select({ slug: events.slug }).from(events).where(isPublicEventStatus()),
    db.select({ slug: venues.slug }).from(venues),
    db
      .select({ slug: vendors.slug })
      .from(vendors)
      .where(and(isNull(vendors.deletedAt))),
    db.select({ slug: promoters.slug }).from(promoters),
    db.select({ slug: blogPosts.slug }).from(blogPosts).where(eq(blogPosts.status, "PUBLISHED")),
  ]);

  return {
    events: new Set(eventRows.map((r) => r.slug as unknown as string)),
    venues: new Set(venueRows.map((r) => r.slug as unknown as string)),
    vendors: new Set(vendorRows.map((r) => r.slug as unknown as string)),
    promoters: new Set(promoterRows.map((r) => r.slug as unknown as string)),
    blog: new Set(blogRows.map((r) => r.slug as unknown as string)),
  };
}

export async function buildCanonicalPathChecker(db: Db): Promise<CanonicalPathChecker> {
  const slugSets = await loadSlugSets(db);
  return makeChecker(slugSets);
}
