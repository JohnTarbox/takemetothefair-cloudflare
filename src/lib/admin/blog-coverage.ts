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
import { and, gte, inArray, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import {
  blogPosts,
  contentLinks,
  gscInspectionState,
  bingInspectionState,
  gscSearchMetrics,
} from "@/lib/db/schema";
import { blogFaqSource, type BlogFaqSource } from "@takemetothefair/utils";
import { classifyIndexState, type IndexState } from "@/lib/gsc-index-state";
import { parseJsonArray } from "@/types";
import { classifyCluster } from "@/lib/admin/blog-clusters";

/** D1 caps bound parameters at 100 per query; stay under with headroom. */
export const BLOG_COVERAGE_PARAM_CHUNK = 90;

/**
 * Rolling window for the GSC clicks/impressions rollup (OPE-96, design brief
 * §6). gsc_search_metrics is GSC's top query×page sample, so these totals
 * UNDER-count the tail — the UI labels them "sampled". 90 days smooths the
 * recent-day reporting lag (OPE-95) while staying recent enough to reflect the
 * current corpus.
 */
export const BLOG_GSC_WINDOW_DAYS = 90;

/** Cutoff as a 'YYYY-MM-DD' string for the `date >= cutoff` filter. */
function gscWindowCutoff(now = new Date()): string {
  const cutoff = new Date(now.getTime() - BLOG_GSC_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return cutoff.toISOString().slice(0, 10);
}

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
  // Bing indexation (OPE-91), from bing_inspection_state. `bingIndexed` is
  // Bing's IsPage flag (true=indexed, false=known-not-indexed, null=unknown/
  // never checked); `bingLastCrawled` is epoch-ms for the page date formatter.
  bingIndexed: boolean | null;
  bingLastCrawled: number | null;
  bingCrawlError: string | null;
  // GSC reach over the rolling window (OPE-96). Summed from gsc_search_metrics
  // rows whose `page` is this post's canonical /blog/<slug> URL. "sampled"
  // (top query×page) — under-counts the tail; labelled as such in the UI.
  // ctr is recomputed from the summed totals (clicks/impressions), NOT an
  // average of per-row ctr; 0 when impressions is 0.
  clicks: number;
  impressions: number;
  ctr: number;
  // Topic bucket (design brief §4), via classifyCluster(slug, tags).
  cluster: string;
  // Age in whole weeks from publishDate; null when the post has no
  // publishDate. Used to flag "still maturing" (SEO takes ~8–12 weeks) vs
  // "mature" so a young 0-click post isn't misjudged as a failure.
  ageWeeks: number | null;
}

/** Per-cluster aggregate for the /admin/blog rollup panel (OPE-96). */
export interface ClusterRollupRow {
  cluster: string;
  posts: number;
  clicks: number;
  clicksPerPost: number;
  impressions: number;
  internalLinks: number;
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
      tags: blogPosts.tags,
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

  // Pass 4 (OPE-91): Bing inspection rows for /blog/<slug>, merged in JS. Same
  // chunk-at-90 as Pass 3 (blogUrls crosses 100 alongside the IN-list above).
  const bingByUrl = new Map<
    string,
    { isIndexed: boolean | null; lastCrawled: Date | null; crawlError: string | null }
  >();
  for (let i = 0; i < blogUrls.length; i += BLOG_COVERAGE_PARAM_CHUNK) {
    const batch = blogUrls.slice(i, i + BLOG_COVERAGE_PARAM_CHUNK);
    const bingRows = await db
      .select({
        url: bingInspectionState.url,
        isIndexed: bingInspectionState.isIndexed,
        lastCrawled: bingInspectionState.lastCrawled,
        crawlError: bingInspectionState.crawlError,
      })
      .from(bingInspectionState)
      .where(inArray(bingInspectionState.url, batch));
    for (const r of bingRows) {
      bingByUrl.set(r.url, {
        isIndexed: r.isIndexed,
        lastCrawled: r.lastCrawled,
        crawlError: r.crawlError,
      });
    }
  }

  // Pass 5 (OPE-96): GSC clicks/impressions for /blog/<slug> over the rolling
  // window. gsc_search_metrics is one row per (date, query, page), so per-post
  // totals are SUM(clicks)+SUM(impressions) across every query and day for the
  // post's canonical URL. We fetch the raw rows with `inArray(page, blogUrls)`
  // chunked at 90 (D1's 100-param cap) + a `date >= cutoff` string filter, then
  // aggregate in JS — a correlated LIKE join trips D1's "LIKE pattern too
  // complex" guard (design brief §6). CTR is recomputed from the summed totals,
  // never averaged from per-row ctr.
  const cutoff = gscWindowCutoff();
  const gscByUrl = new Map<string, { clicks: number; impressions: number }>();
  for (let i = 0; i < blogUrls.length; i += BLOG_COVERAGE_PARAM_CHUNK) {
    const batch = blogUrls.slice(i, i + BLOG_COVERAGE_PARAM_CHUNK);
    const metricRows = await db
      .select({
        page: gscSearchMetrics.page,
        clicks: gscSearchMetrics.clicks,
        impressions: gscSearchMetrics.impressions,
      })
      .from(gscSearchMetrics)
      .where(and(inArray(gscSearchMetrics.page, batch), gte(gscSearchMetrics.date, cutoff)));
    for (const r of metricRows) {
      const agg = gscByUrl.get(r.page) ?? { clicks: 0, impressions: 0 };
      agg.clicks += Number(r.clicks ?? 0);
      agg.impressions += Number(r.impressions ?? 0);
      gscByUrl.set(r.page, agg);
    }
  }

  const now = Date.now();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  return posts.map((p) => {
    const counts = countsByPost.get(p.id) ?? { event: 0, vendor: 0, venue: 0, blog: 0 };
    const total = counts.event + counts.vendor + counts.venue + counts.blog;
    const url = `https://meetmeatthefair.com/blog/${p.slug}`;
    const inspect = inspectionByUrl.get(url);
    const bing = bingByUrl.get(url);
    const gsc = gscByUrl.get(url) ?? { clicks: 0, impressions: 0 };
    const ctr = gsc.impressions > 0 ? gsc.clicks / gsc.impressions : 0;
    const ageWeeks = p.publishDate
      ? Math.max(0, Math.floor((now - p.publishDate.getTime()) / WEEK_MS))
      : null;
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
      bingIndexed: bing?.isIndexed ?? null,
      bingLastCrawled: bing?.lastCrawled ? bing.lastCrawled.getTime() : null,
      bingCrawlError: bing?.crawlError ?? null,
      clicks: gsc.clicks,
      impressions: gsc.impressions,
      ctr,
      cluster: classifyCluster({ slug: p.slug, tags: parseJsonArray(p.tags) }),
      ageWeeks,
    };
  });
}

/**
 * Roll the per-post rows up into per-cluster aggregates for the /admin/blog
 * scorecard panel (OPE-96). internalLinks per post is the event+vendor+venue
 * link count (excludes blog→blog links — the panel measures downstream
 * distribution to events/vendors/venues). Sorted by clicks desc, then
 * clicks/post desc — matching the design brief §5 ordering.
 */
export function blogClusterRollup(rows: PostRow[]): ClusterRollupRow[] {
  const byCluster = new Map<
    string,
    { posts: number; clicks: number; impressions: number; internalLinks: number }
  >();
  for (const r of rows) {
    const agg = byCluster.get(r.cluster) ?? {
      posts: 0,
      clicks: 0,
      impressions: 0,
      internalLinks: 0,
    };
    agg.posts += 1;
    agg.clicks += r.clicks;
    agg.impressions += r.impressions;
    agg.internalLinks += r.eventLinks + r.vendorLinks + r.venueLinks;
    byCluster.set(r.cluster, agg);
  }
  return [...byCluster.entries()]
    .map(([cluster, a]) => ({
      cluster,
      posts: a.posts,
      clicks: a.clicks,
      clicksPerPost: a.posts > 0 ? a.clicks / a.posts : 0,
      impressions: a.impressions,
      internalLinks: a.internalLinks,
    }))
    .sort((a, b) => b.clicks - a.clicks || b.clicksPerPost - a.clicksPerPost);
}
