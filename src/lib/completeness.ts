/**
 * Stateful (DB-bound) completeness helpers. The pure scoring functions live
 * in @takemetothefair/utils so the MCP server can use them too without
 * pulling the @/lib alias.
 *
 * Call recomputeVendorCompleteness / recomputeEventCompleteness AFTER any
 * insert/update that touched a scored field. Idempotent and read-then-write,
 * so callers can patch arbitrary subsets and trust the score reflects the
 * post-write row.
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
