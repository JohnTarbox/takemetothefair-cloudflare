/**
 * Per-sitemap-type "last modified" lookup. Used by the sitemap index
 * (`/sitemap.xml`) so each child entry carries a real content-change
 * timestamp instead of "now" — that's what makes the split sitemap pay off
 * for crawl-budget allocation (Google decides which child to refetch based
 * on `<lastmod>` deltas).
 *
 * Each query is a single MAX(updated_at) and runs in parallel from the
 * index handler. The visibility filter on each is a deliberate approximation
 * of the corresponding child sitemap's set: tight enough that an internal-
 * only edit (DRAFT → DRAFT description tweak) doesn't move the signal,
 * loose enough that we don't have to re-implement the full sitemap-vendors
 * quality gate at MAX time. When a row that survives the child's filter
 * gets updated, MAX will move.
 *
 * Returns Date | null. `null` means the type has zero rows that qualify,
 * in which case the caller emits an entry with no `<lastmod>` — better
 * than a fake timestamp.
 */
import { and, eq, isNull, max } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { blogPosts, events, promoters, vendors, venues } from "@/lib/db/schema";
import { isPublicEventStatus } from "@/lib/event-status";

export type SitemapType = "static" | "events" | "venues" | "vendors" | "promoters" | "blog";

// Vendor rows were historically written as ms-epoch where the Drizzle
// `mode: "timestamp"` convention expects seconds-epoch; reading such rows
// produced a Date in year ~58308. Backfilled in
// drizzle/0111_backfill_vendor_updated_at_to_seconds.sql; the defensive
// correctMsOverflow guard that used to live here has been removed.
async function maxFor(query: Promise<Array<{ value: Date | null }>>): Promise<Date | null> {
  try {
    const rows = await query;
    const v = rows[0]?.value;
    if (!v) return null;
    if (!(v instanceof Date) || isNaN(v.getTime())) return null;
    return v;
  } catch (err) {
    console.error("sitemap-lastmod: query failed", err);
    return null;
  }
}

/** MAX(updated_at) across the same row-set the corresponding child sitemap
 *  emits. Static is a special case — no DB rows back it, so the answer is
 *  "whenever the deploy ran". Returning `null` would suppress the entry's
 *  <lastmod>, which is fine: the index entry just won't carry a timestamp. */
export async function getSitemapTypeLastMod(type: SitemapType): Promise<Date | null> {
  const db = getCloudflareDb();
  switch (type) {
    case "events":
      return maxFor(
        db
          .select({ value: max(events.updatedAt) })
          .from(events)
          .where(isPublicEventStatus())
      );
    case "venues":
      // All venues are public (sitemap-venues emits the whole table).
      return maxFor(db.select({ value: max(venues.updatedAt) }).from(venues));
    case "vendors": {
      // Sitemap-vendors raw-SQLs its query and stores seconds-epoch; the
      // Drizzle `vendors.updatedAt` column is a timestamp ("seconds" mode),
      // so `max(vendors.updatedAt)` returns a Date. We apply the bare-
      // minimum visibility filter (the deeper enhanced-profile / quality
      // gate is intentionally not duplicated here — see the file header).
      return maxFor(
        db
          .select({ value: max(vendors.updatedAt) })
          .from(vendors)
          .where(and(isNull(vendors.deletedAt), eq(vendors.domainHijacked, false)))
      );
    }
    case "promoters":
      return maxFor(db.select({ value: max(promoters.updatedAt) }).from(promoters));
    case "blog":
      return maxFor(
        db
          .select({ value: max(blogPosts.updatedAt) })
          .from(blogPosts)
          .where(eq(blogPosts.status, "PUBLISHED"))
      );
    case "static":
      // No content backing this child — the only way the static set
      // changes is a code deploy. Returning null lets the index omit the
      // <lastmod> entirely, which is more honest than emitting "now".
      return null;
    default: {
      // Exhaustive check — the union should cover every case.
      const _exhaustive: never = type;
      void _exhaustive;
      return null;
    }
  }
}
