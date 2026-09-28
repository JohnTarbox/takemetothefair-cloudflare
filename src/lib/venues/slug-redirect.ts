/**
 * Resolve a /venues/<slug> request to a 301 target, or null (serve / 404).
 *
 * OPE-1183 — the 13 `*-merged-<id8>` tombstone slugs 404'd. The middleware
 * short-circuited on ANY venue row at the requested slug ("live row → render
 * normally"), and a merge tombstone IS a row at its parked slug — status
 * INACTIVE, which the page then refuses. So the history walk was never reached
 * for exactly the slugs that most needed it. Only a non-INACTIVE row now counts
 * as "live"; an INACTIVE row falls through to the walk.
 *
 * Walk: up to 5 hops through venue_slug_history (cycle-safe), then 301 only if
 * the terminus is a live venue. A slug with no history (a bogus one, or a
 * retired non-merged venue like `vermont-state-fairgrounds`) returns null and
 * keeps its 404 — no OPE-420 soft-404 regression.
 */
import { and, desc, eq, ne } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { venueSlugHistory, venues } from "@/lib/db/schema";
import { unsafeSlug } from "@takemetothefair/utils";

type Db = Pick<DrizzleD1Database, "select">;

const liveAt = (slug: string) =>
  and(eq(venues.slug, unsafeSlug(slug)), ne(venues.status, "INACTIVE"));

export async function resolveVenueRedirect(db: Db, slug: string): Promise<string | null> {
  const [live] = await db.select({ id: venues.id }).from(venues).where(liveAt(slug)).limit(1);
  if (live) return null;

  let cursor = slug;
  let lastVenueId: string | null = null;
  const seen = new Set<string>([cursor]);
  for (let hop = 0; hop < 5; hop++) {
    const [row] = await db
      .select({ newSlug: venueSlugHistory.newSlug, venueId: venueSlugHistory.venueId })
      .from(venueSlugHistory)
      .where(eq(venueSlugHistory.oldSlug, unsafeSlug(cursor)))
      .orderBy(desc(venueSlugHistory.changedAt))
      .limit(1);
    if (!row || seen.has(row.newSlug)) break;
    cursor = row.newSlug;
    lastVenueId = row.venueId;
    seen.add(cursor);
  }
  if (cursor === slug) return null;
  const [target] = await db.select({ id: venues.id }).from(venues).where(liveAt(cursor)).limit(1);
  if (target) return cursor;

  // The chain ended on a slug nobody holds — a keeper renamed after the fact
  // with no history row (deerfield-fair-1 was renamed back to
  // deerfield-fairgrounds). Every history row names its target venue, so
  // follow that venue to wherever it lives now.
  if (lastVenueId) {
    const [byId] = await db
      .select({ slug: venues.slug })
      .from(venues)
      .where(and(eq(venues.id, lastVenueId), ne(venues.status, "INACTIVE")))
      .limit(1);
    if (byId && byId.slug !== slug) return byId.slug;
  }
  return null;
}
