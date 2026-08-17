/**
 * Stateful (DB-bound) completeness helpers. The pure scoring functions live
 * in @takemetothefair/utils so the MCP server can use them too without
 * pulling the @/lib alias.
 *
 * Call recomputeVendorCompleteness / recomputeEventCompleteness AFTER any
 * insert/update that touched a scored field. Idempotent and read-then-write,
 * so callers can patch arbitrary subsets and trust the score reflects the
 * post-write row.
 *
 * ---------------------------------------------------------------------------
 * OPE-439 — what this score is, and what may consume it
 * ---------------------------------------------------------------------------
 *
 * It measures FIELDS FILLED, not correctness. That is what its name says, and
 * it is worth stating loudly because the number reads like a quality signal.
 *
 * A real example: an email submission produced a junk duplicate scoring **85**
 * beside the APPROVED event it duplicated at **60**. The duplicate had NO
 * venue, a placeholder promoter and 0 views; it won on having a description
 * and ticket prices. Its sibling row carried fabricated 2024 dates (OPE-432)
 * and also scored well. Presence is not evidence.
 *
 * The danger was never the arithmetic — it is what sorts by it. Full consumer
 * census, taken 2026-08-17:
 *
 *   sitemap inclusion      `completeness_score >= SITEMAP_MIN_COMPLETENESS`
 *                          BUT gated behind `isPublicEventStatus()`, so a
 *                          PENDING row cannot reach the sitemap at any score.
 *   vendor enrichment      ORDER BY completeness_score **ASC** — least
 *     selector             complete first. Correct direction; a padded row is
 *                          deprioritised, not promoted. Vendors, not events.
 *   admin analytics /      read-only display and KPI aggregates.
 *     KPI states
 *   admin review queue     orders by createdAt / startDate. NOT by this score.
 *
 * So the feared failure — a reviewer working highest-score-first, with
 * fabricated rows sorted to the top and attention inversely allocated — does
 * NOT exist today. If you are about to add an ORDER BY on this column to
 * anything a human triages, that is the moment to reconsider: gate it on
 * verifiability (an uncited field, or `venue_id IS NULL`, should not earn
 * points) rather than presence. Same family as `dates_confirmed` in OPE-433 —
 * a confidence-shaped number with no evidence behind it.
 *
 * The one property that keeps the sitemap consumer safe is the public-status
 * gate, not the threshold. `indexable-events.test.ts` pins it.
 */
import { eq } from "drizzle-orm";
import { vendors, events } from "@/lib/db/schema";
import {
  computeVendorCompletenessScore,
  computeEventCompletenessScore,
} from "@takemetothefair/utils";
import type { getCloudflareDb } from "@/lib/cloudflare";

export {
  computeVendorCompletenessScore,
  computeEventCompletenessScore,
  SITEMAP_MIN_COMPLETENESS,
} from "@takemetothefair/utils";

type Db = ReturnType<typeof getCloudflareDb>;

export async function recomputeVendorCompleteness(
  db: Db,
  vendorId: string
): Promise<number | null> {
  const [row] = await db
    .select({
      description: vendors.description,
      logoUrl: vendors.logoUrl,
      contactPhone: vendors.contactPhone,
      contactEmail: vendors.contactEmail,
      website: vendors.website,
      vendorType: vendors.vendorType,
      products: vendors.products,
      claimed: vendors.claimed,
    })
    .from(vendors)
    .where(eq(vendors.id, vendorId))
    .limit(1);
  if (!row) return null;
  const score = computeVendorCompletenessScore(row);
  await db.update(vendors).set({ completenessScore: score }).where(eq(vendors.id, vendorId));
  return score;
}

export async function recomputeEventCompleteness(db: Db, eventId: string): Promise<number | null> {
  const [row] = await db
    .select({
      description: events.description,
      startDate: events.startDate,
      endDate: events.endDate,
      venueId: events.venueId,
      isStatewide: events.isStatewide,
      categories: events.categories,
      imageUrl: events.imageUrl,
      ticketPriceMinCents: events.ticketPriceMinCents,
      ticketPriceMaxCents: events.ticketPriceMaxCents,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (!row) return null;
  const score = computeEventCompletenessScore(row);
  await db.update(events).set({ completenessScore: score }).where(eq(events.id, eventId));
  return score;
}
