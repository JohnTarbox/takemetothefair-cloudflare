/**
 * Blog coverage loader for /admin/blog — extracted from the page (OPE-79) so the
 * D1-bound-parameter-cap chunking is unit-testable past the 100-row ceiling.
 *
 * The page selects every blog post and then looks up per-post internal-link
 * counts (content_links) + GSC index/coverage state (gsc_inspection_state).
 * Both lookups are `IN (…post ids / urls…)` — and D1 caps bound parameters at
 * 100 per query. Once the corpus grew past 100 posts (114 now), the unbounded
 * IN-lists threw "too many SQL variables" and crashed the render on every load.
 * Every IN-list here is chunked at 90 and merged in JS.
 */
import { inArray, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { blogPosts, contentLinks, gscInspectionState } from "@/lib/db/schema";
import { blogFaqSource, type BlogFaqSource } from "@takemetothefair/utils";
import { classifyIndexState, type IndexState } from "@/lib/gsc-index-state";

/** D1 caps bound parameters at 100 per query; stay under with headroom. */
export const BLOG_COVERAGE_PARAM_CHUNK = 90;

export interface PostRow {
  id: string;
  slug: string;
  title: string;
  status: string;
  publishDate: Date | null;
  // Internal-link footprint, split by target type so a 12-event post
  // and a 12-vendor post don't look identical in the rollup.
  eventLinks: number;
  vendorLinks: number;
  venueLinks: number;
  blogLinks: number;
  totalLinks: number;
  faqSource: BlogFaqSource;
  indexState: IndexState;
  // GSC's verbatim coverageState string ("Submitted and indexed" /
  // "Discovered – currently not indexed" / etc.). Surfaced so the
  // operator can disambiguate the `unknown` bucket when needed.
  coverageState: string | null;
}

type CountBucket = { event: number; vendor: number; venue: number; blog: number };

/**
 * Build the per-post coverage rows. Takes the db as a parameter so it's testable
 * against better-sqlite3 (the page passes `getCloudflareDb()`).
 */
export async function loadBlogCoverageRows(db: Database): Promise<PostRow[]> {
  // Pass 1: every blog post we care about (DRAFT counts too — the link footprint
  // exists on unpublished posts and the operator wants to see it before flipping
  // to PUBLISHED).
  const posts = await db
    .select({
      id: blogPosts.id,
      slug: blogPosts.slug,
      title: blogPosts.title,
      status: blogPosts.status,
      publishDate: blogPosts.publishDate,
      faqs: blogPosts.faqs,
      body: blogPosts.body,
    })
    .from(blogPosts);

  if (posts.length === 0) return [];

  const postIds = posts.map((p) => p.id);

  // Pass 2: content_links from these posts, grouped by (sourceId, targetType),
  // merged into the posts map in JS. Chunked at 90 (OPE-79 — see file header).
  const countsByPost = new Map<string, CountBucket>();
  for (let i = 0; i < postIds.length; i += BLOG_COVERAGE_PARAM_CHUNK) {
    const batch = postIds.slice(i, i + BLOG_COVERAGE_PARAM_CHUNK);
    const linkCounts = await db
      .select({
        sourceId: contentLinks.sourceId,
        targetType: contentLinks.targetType,
        count: sql<number>`COUNT(*)`,
      })
      .from(contentLinks)
      .where(inArray(contentLinks.sourceId, batch))
      .groupBy(contentLinks.sourceId, contentLinks.targetType);
    for (const r of linkCounts) {
      const bucket = countsByPost.get(r.sourceId) ?? { event: 0, vendor: 0, venue: 0, blog: 0 };
      const n = Number(r.count ?? 0);
      if (r.targetType === "EVENT") bucket.event += n;
      else if (r.targetType === "VENDOR") bucket.vendor += n;
      else if (r.targetType === "VENUE") bucket.venue += n;
      else if (r.targetType === "BLOG_POST") bucket.blog += n;
      countsByPost.set(r.sourceId, bucket);
    }
  }

  // Pass 3: GSC inspection rows for /blog/<slug>, merged in JS. Same chunk-at-90
  // (blogUrls scales with post count and crosses 100 alongside the IN-list above).
  const blogUrls = posts.map((p) => `https://meetmeatthefair.com/blog/${p.slug}`);
  const inspectionByUrl = new Map<
    string,
    { lastVerdict: string | null; lastCoverageState: string | null }
  >();
  for (let i = 0; i < blogUrls.length; i += BLOG_COVERAGE_PARAM_CHUNK) {
    const batch = blogUrls.slice(i, i + BLOG_COVERAGE_PARAM_CHUNK);
    const inspectionRows = await db
      .select({
        url: gscInspectionState.url,
        lastVerdict: gscInspectionState.lastVerdict,
        lastCoverageState: gscInspectionState.lastCoverageState,
      })
      .from(gscInspectionState)
      .where(inArray(gscInspectionState.url, batch));
    for (const r of inspectionRows) {
      inspectionByUrl.set(r.url, {
        lastVerdict: r.lastVerdict,
        lastCoverageState: r.lastCoverageState,
      });
    }
  }

  return posts.map((p) => {
    const counts = countsByPost.get(p.id) ?? { event: 0, vendor: 0, venue: 0, blog: 0 };
    const total = counts.event + counts.vendor + counts.venue + counts.blog;
    const inspect = inspectionByUrl.get(`https://meetmeatthefair.com/blog/${p.slug}`);
    const indexState = classifyIndexState(
      inspect?.lastVerdict ?? null,
      inspect?.lastCoverageState ?? null
    );
    return {
      id: p.id,
      slug: p.slug,
      title: p.title,
      status: p.status,
      publishDate: p.publishDate,
      eventLinks: counts.event,
      vendorLinks: counts.vendor,
      venueLinks: counts.venue,
      blogLinks: counts.blog,
      totalLinks: total,
      faqSource: blogFaqSource(p.faqs, p.body),
      indexState,
      coverageState: inspect?.lastCoverageState ?? null,
    };
  });
}
