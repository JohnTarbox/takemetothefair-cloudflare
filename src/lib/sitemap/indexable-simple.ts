/**
 * OPE-806 — published allow-lists for venues, promoters and blog.
 *
 * ## The invariant
 *
 * > Every identifier a scanner asserts on must be present in the published
 * > allow-list for its entity type, or excluded from it with a stated reason.
 *
 * `indexable-vendors.ts` has enforced this for vendors since 2026-06-26, so the
 * GSC sweep never inspects a vendor page the sitemap withholds — *"which would
 * surface as false-positive noise"*. Events did not get the same treatment
 * until OPE-372, and the bill for the gap was **81 of 318 open `health_issues`
 * rows — 25% of an operator queue — self-manufactured and regenerated daily**,
 * because the sitemap builder and the sweep's picker constructed the same URLs
 * from different fields under different gates.
 *
 * Venues, promoters and blog had neither an allow-list nor choke-point
 * coverage. The fix pattern had been sitting in this directory the whole time.
 *
 * ## Why these three share a file and vendors/events do not
 *
 * Not tidiness — their gates are genuinely one-liners, and each is read
 * straight off the sitemap route it mirrors:
 *
 *   venues     `status = 'ACTIVE'`          (sitemap-venues.xml/route.ts:20)
 *   promoters  no filter — all are public   (sitemap-promoters.xml/route.ts:20)
 *   blog       `status = 'PUBLISHED'`       (sitemap-blog.xml/route.ts:36)
 *
 * `indexable-vendors` walks `event_vendors → events → venues` for a geographic
 * anchor and `indexable-events` resolves canonical nested URLs for series
 * occurrences. Those earn their own modules; these would be three files of five
 * lines each pretending to be architecture.
 *
 * ⚠️ **The gates are duplicated from the sitemap routes, which is the very
 * split-construction this ticket is about.** It is accepted here for one
 * reason: the property test asserts these sets equal what the sitemap routes
 * publish, so a divergence fails CI rather than quietly refilling the operator
 * queue. If a gate grows past a single predicate, give it a module and have the
 * sitemap import it — do not let the copy drift.
 *
 * ## Set membership, never shape
 *
 * Callers must filter on membership in these sets. Filtering on URL *shape* is
 * the trap OPE-806 names explicitly: 67 sitemap URLs legitimately match
 * `/events/<slug>-<year>` because their slug genuinely ends in a year, so a
 * regex over the malformed pattern would silently stop inspecting 67 real
 * pages — one blind spot traded for another.
 */
import { eq } from "drizzle-orm";
import { blogPosts, promoters, venues } from "@/lib/db/schema";
import type { Db } from "@/lib/analytics-overview/shared";

/** Path prefixes this module owns. Exported so callers cannot mistype one. */
export const SIMPLE_ENTITY_PREFIXES = ["/venues/", "/promoters/", "/blog/"] as const;
export type SimpleEntityPrefix = (typeof SIMPLE_ENTITY_PREFIXES)[number];

/**
 * Venue slugs whose detail page is index-eligible.
 * Mirrors `sitemap-venues.xml/route.ts` — `status = 'ACTIVE'`.
 */
export async function getIndexableVenueSlugs(db: Db): Promise<string[]> {
  const rows = await db
    .select({ slug: venues.slug })
    .from(venues)
    .where(eq(venues.status, "ACTIVE"));
  return rows.map((r) => String(r.slug ?? "")).filter((s) => s.length > 0);
}

/**
 * Promoter slugs whose detail page is index-eligible.
 *
 * Mirrors `sitemap-promoters.xml/route.ts`, which applies **no filter** — the
 * table has no status column and every promoter is public. An allow-list that
 * admits everything still matters: it is what stops a filler tier recycling a
 * DELETED promoter's URL out of `gsc_inspection_state`, which is a set the
 * sitemap has not published for as long as that row has existed.
 */
export async function getIndexablePromoterSlugs(db: Db): Promise<string[]> {
  const rows = await db.select({ slug: promoters.slug }).from(promoters);
  return rows.map((r) => String(r.slug ?? "")).filter((s) => s.length > 0);
}

/**
 * Blog slugs whose post page is index-eligible.
 * Mirrors `sitemap-blog.xml/route.ts` — `status = 'PUBLISHED'`.
 */
export async function getIndexableBlogSlugs(db: Db): Promise<string[]> {
  const rows = await db
    .select({ slug: blogPosts.slug })
    .from(blogPosts)
    .where(eq(blogPosts.status, "PUBLISHED"));
  return rows.map((r) => String(r.slug ?? "")).filter((s) => s.length > 0);
}

/**
 * Every allow-listed URL for these three types, keyed by path prefix.
 *
 * One round trip per type, run in parallel. Returned as absolute URLs because
 * that is what the sweep compares against.
 */
export async function getSimpleEntityAllowList(
  db: Db,
  host: string
): Promise<Map<SimpleEntityPrefix, Set<string>>> {
  const [venueSlugs, promoterSlugs, blogSlugs] = await Promise.all([
    getIndexableVenueSlugs(db),
    getIndexablePromoterSlugs(db),
    getIndexableBlogSlugs(db),
  ]);
  return new Map<SimpleEntityPrefix, Set<string>>([
    ["/venues/", new Set(venueSlugs.map((s) => `${host}/venues/${s}`))],
    ["/promoters/", new Set(promoterSlugs.map((s) => `${host}/promoters/${s}`))],
    ["/blog/", new Set(blogSlugs.map((s) => `${host}/blog/${s}`))],
  ]);
}
