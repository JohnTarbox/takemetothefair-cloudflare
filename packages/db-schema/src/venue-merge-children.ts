/**
 * OPE-1232 — what a venue merge must do to the loser's rows besides events.
 *
 * Both merge paths (the `merge_venue` MCP tool, which tombstones the loser, and
 * the app's /api/admin/duplicates/merge, which hard-deletes it) moved only
 * `events.venue_id`. Every other table that REFERENCES venues was left on the
 * loser:
 *   - `event_series.venue_id` — measured 2026-10-01, 10 series hubs pointing at
 *     INACTIVE `*-merged-*` tombstones (Tunbridge ×3, Champlain Valley ×2,
 *     Royal Plaza, …). On the hard-delete path the FK is ON DELETE SET NULL,
 *     so the series silently lost its venue instead.
 *   - `series_venue_periods`, `venue_name_variants`, `venue_claim_citations`,
 *     `venue_slug_history` — all ON DELETE CASCADE, so the hard-delete path
 *     DESTROYED the loser's history, names, sources and redirects.
 *
 * One function, called by BOTH paths before the tombstone/delete, the same
 * shape as `repointPromoterChildren` (OPE-1120) and for the same reason.
 */
import { eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./index";

type Db = DrizzleD1Database<typeof schema>;

export interface VenueChildRepointResult {
  seriesRepointed: number;
  periodsRepointed: number;
  /** Name variants moved to the keeper. */
  variantsRepointed: number;
  /** Loser variants the keeper already had (same normalized name): their citations move to the keeper's row, then the duplicate row is removed. */
  variantsFolded: number;
  citationsRepointed: number;
  /** The loser's own old-slug redirects, now pointing straight at the keeper. */
  slugHistoryRepointed: number;
}

export async function repointVenueChildren(
  db: Db,
  keeperId: string,
  loserId: string
): Promise<VenueChildRepointResult> {
  if (keeperId === loserId)
    throw new Error("repointVenueChildren: keeper and loser are the same venue");
  const [keeper] = await db
    .select({ id: schema.venues.id, slug: schema.venues.slug })
    .from(schema.venues)
    .where(eq(schema.venues.id, keeperId))
    .limit(1);
  if (!keeper) throw new Error(`repointVenueChildren: keeper ${keeperId} not found`);

  const series = await db
    .update(schema.eventSeries)
    .set({ venueId: keeperId })
    .where(eq(schema.eventSeries.venueId, loserId))
    .returning({ id: schema.eventSeries.id });

  const periods = await db
    .update(schema.seriesVenuePeriods)
    .set({ venueId: keeperId })
    .where(eq(schema.seriesVenuePeriods.venueId, loserId))
    .returning({ id: schema.seriesVenuePeriods.id });

  // venue_name_variants is UNIQUE (venue_id, normalized_name). A name both
  // venues already carry cannot move; its citations are re-attached to the
  // keeper's row first, so deleting the duplicate cascades nothing away.
  const loserVariants = await db
    .select({ id: schema.venueNameVariants.id, key: schema.venueNameVariants.normalizedName })
    .from(schema.venueNameVariants)
    .where(eq(schema.venueNameVariants.venueId, loserId));
  const keeperByKey = new Map(
    (
      await db
        .select({ id: schema.venueNameVariants.id, key: schema.venueNameVariants.normalizedName })
        .from(schema.venueNameVariants)
        .where(eq(schema.venueNameVariants.venueId, keeperId))
    ).map((v) => [v.key, v.id])
  );
  const move: string[] = [];
  let folded = 0;
  for (const v of loserVariants) {
    const keeperVariant = keeperByKey.get(v.key);
    if (!keeperVariant) {
      move.push(v.id);
      continue;
    }
    await db
      .update(schema.venueClaimCitations)
      .set({ venueNameVariantId: keeperVariant })
      .where(eq(schema.venueClaimCitations.venueNameVariantId, v.id));
    await db.delete(schema.venueNameVariants).where(eq(schema.venueNameVariants.id, v.id));
    folded++;
  }
  // Text ids, chunked under D1's 100-bound-parameter cap.
  for (let i = 0; i < move.length; i += 90) {
    await db
      .update(schema.venueNameVariants)
      .set({ venueId: keeperId })
      .where(inArray(schema.venueNameVariants.id, move.slice(i, i + 90)));
  }

  const citations = await db
    .update(schema.venueClaimCitations)
    .set({ venueId: keeperId })
    .where(eq(schema.venueClaimCitations.venueId, loserId))
    .returning({ id: schema.venueClaimCitations.id });

  // The loser's own earlier renames: re-own them (so a hard delete cannot
  // cascade them away) and aim them at the keeper in one hop.
  const history = await db
    .update(schema.venueSlugHistory)
    .set({ venueId: keeperId, newSlug: keeper.slug })
    .where(eq(schema.venueSlugHistory.venueId, loserId))
    .returning({ id: schema.venueSlugHistory.id });

  return {
    seriesRepointed: series.length,
    periodsRepointed: periods.length,
    variantsRepointed: move.length,
    variantsFolded: folded,
    citationsRepointed: citations.length,
    slugHistoryRepointed: history.length,
  };
}
