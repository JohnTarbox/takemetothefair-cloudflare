/**
 * Per-post blog coverage + indexation status (analyst A4, 2026-05-29).
 *
 * Surfaces three slices of "is this post pulling its weight?":
 *   1. Internal-link footprint — how many content_links rows reference
 *      events/vendors/venues from this post (split by targetType). Low
 *      counts mean the post is hard to discover from elsewhere on the
 *      site; high counts mean it's a good hub.
 *   2. FAQ source — emitted JSON-LD comes from the blog_posts.faqs
 *      column or from `## Q:` markdown headings (or neither). Drift
 *      between intended-vs-actual is invisible without this column.
 *   3. Indexation status — joined from gsc_inspection_state on URL
 *      `/blog/<slug>`. Surfaces stuck-in-discovered / crawled-not-
 *      indexed posts so the operator can request indexing or rewrite
 *      thin content.
 *
 * Built on the same admin-page conventions as /admin/source-quality
 * (server component, edge runtime, no client interactivity beyond
 * the sort query param).
 */

import Link from "next/link";
import { inArray, sql } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { blogPosts, contentLinks, gscInspectionState } from "@/lib/db/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { blogFaqSource, type BlogFaqSource } from "@takemetothefair/utils";
import { classifyIndexState, type IndexState } from "@/lib/gsc-index-state";

export const runtime = "edge";
export const revalidate = 300;

interface PostRow {
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

type SortKey =
  | "title"
  | "publishDate"
  | "totalLinks"
  | "eventLinks"
  | "vendorLinks"
  | "venueLinks"
  | "faqSource"
  | "indexState";

const SORT_VALUES: SortKey[] = [
  "title",
  "publishDate",
  "totalLinks",
  "eventLinks",
  "vendorLinks",
  "venueLinks",
  "faqSource",
  "indexState",
];

async function loadRows(): Promise<PostRow[]> {
  const db = getCloudflareDb();

  // Pass 1: every blog post we care about (DRAFT counts too — the link
  // footprint exists on unpublished posts and the operator wants to see
  // it before flipping to PUBLISHED).
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

  // Pass 2: content_links from these posts, grouped by (sourceId,
  // targetType). One pass over the join table; merge into the posts
  // map in JS. Avoids a per-post subquery (would be 100+ queries on the
  // current ~150-post corpus).
  const linkCounts = await db
    .select({
      sourceId: contentLinks.sourceId,
      targetType: contentLinks.targetType,
      count: sql<number>`COUNT(*)`,
    })
    .from(contentLinks)
    .where(inArray(contentLinks.sourceId, postIds))
    .groupBy(contentLinks.sourceId, contentLinks.targetType);

  type CountBucket = { event: number; vendor: number; venue: number; blog: number };
  const countsByPost = new Map<string, CountBucket>();
  for (const r of linkCounts) {
    const bucket = countsByPost.get(r.sourceId) ?? { event: 0, vendor: 0, venue: 0, blog: 0 };
    const n = Number(r.count ?? 0);
    if (r.targetType === "EVENT") bucket.event += n;
    else if (r.targetType === "VENDOR") bucket.vendor += n;
    else if (r.targetType === "VENUE") bucket.venue += n;
    else if (r.targetType === "BLOG_POST") bucket.blog += n;
    countsByPost.set(r.sourceId, bucket);
  }

  // Pass 3: GSC inspection rows for /blog/<slug>. Same one-pass merge
  // as the link counts — small corpus, one IN-list, no joins.
  const blogUrls = posts.map((p) => `https://meetmeatthefair.com/blog/${p.slug}`);
  const inspectionRows = await db
    .select({
      url: gscInspectionState.url,
      lastVerdict: gscInspectionState.lastVerdict,
      lastCoverageState: gscInspectionState.lastCoverageState,
    })
    .from(gscInspectionState)
    .where(inArray(gscInspectionState.url, blogUrls));
  const inspectionByUrl = new Map(
    inspectionRows.map((r) => [
      r.url,
      { lastVerdict: r.lastVerdict, lastCoverageState: r.lastCoverageState },
    ])
  );

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

function sortRows(rows: PostRow[], key: SortKey): PostRow[] {
  // Default direction per key chosen so the most-actionable bucket is
  // at the top. Tiebreaker = title ascending for stable rendering.
  const tieBreak = (a: PostRow, b: PostRow) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  switch (key) {
    case "title":
      return [...rows].sort((a, b) => tieBreak(a, b));
    case "publishDate":
      return [...rows].sort(
        (a, b) =>
          (b.publishDate?.getTime() ?? 0) - (a.publishDate?.getTime() ?? 0) || tieBreak(a, b)
      );
    case "totalLinks":
      return [...rows].sort((a, b) => b.totalLinks - a.totalLinks || tieBreak(a, b));
    case "eventLinks":
      return [...rows].sort((a, b) => b.eventLinks - a.eventLinks || tieBreak(a, b));
    case "vendorLinks":
      return [...rows].sort((a, b) => b.vendorLinks - a.vendorLinks || tieBreak(a, b));
    case "venueLinks":
      return [...rows].sort((a, b) => b.venueLinks - a.venueLinks || tieBreak(a, b));
    case "faqSource": {
      // "none" first because that's the gap to close.
      const rank: Record<BlogFaqSource, number> = { none: 0, markdown: 1, column: 2 };
      return [...rows].sort((a, b) => rank[a.faqSource] - rank[b.faqSource] || tieBreak(a, b));
    }
    case "indexState": {
      // discovered-not-indexed and crawled-not-indexed first — these
      // are the rows the operator should act on.
      const rank: Record<IndexState, number> = {
        discovered_not_indexed: 0,
        crawled_not_indexed: 1,
        unknown: 2,
        indexed: 3,
      };
      return [...rows].sort((a, b) => rank[a.indexState] - rank[b.indexState] || tieBreak(a, b));
    }
  }
}

function indexStateChip(state: IndexState): { label: string; cls: string } {
  switch (state) {
    case "indexed":
      return { label: "indexed", cls: "bg-green-50 text-green-800 border-green-200" };
    case "discovered_not_indexed":
      return {
        label: "discovered, not indexed",
        cls: "bg-red-50 text-red-800 border-red-300",
      };
    case "crawled_not_indexed":
      return {
        label: "crawled, not indexed",
        cls: "bg-amber-50 text-amber-800 border-amber-300",
      };
    case "unknown":
      return { label: "unknown", cls: "bg-muted text-muted-foreground border-border" };
  }
}

function faqSourceChip(source: BlogFaqSource): { label: string; cls: string } {
  switch (source) {
    case "column":
      return { label: "column", cls: "bg-info-soft text-navy-dark border-info-soft" };
    case "markdown":
      return { label: "markdown", cls: "bg-purple-50 text-purple-800 border-purple-200" };
    case "none":
      return { label: "none", cls: "bg-muted text-muted-foreground border-border" };
  }
}

function formatDate(d: Date | null): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 10);
}

interface SortHeaderProps {
  label: string;
  k: SortKey;
  active: SortKey;
  align?: "left" | "right";
}

function SortHeader({ label, k, active, align = "left" }: SortHeaderProps) {
  const isActive = active === k;
  return (
    <th className={`px-4 py-2 font-medium ${align === "right" ? "text-right" : "text-left"}`}>
      <Link
        href={`/admin/blog?sort=${k}`}
        className={`hover:text-foreground ${isActive ? "text-foreground font-semibold" : "text-muted-foreground"}`}
      >
        {label}
        {isActive ? " ▾" : ""}
      </Link>
    </th>
  );
}

export default async function BlogCoveragePage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string }>;
}) {
  const sp = await searchParams;
  const sort: SortKey = SORT_VALUES.includes(sp.sort as SortKey)
    ? (sp.sort as SortKey)
    : "totalLinks";

  const rows = sortRows(await loadRows(), sort);

  // Rollup tiles. Counted from `rows` so they always agree with the
  // table — no second query, no drift if the rendering filter changes.
  const totalPosts = rows.length;
  const publishedPosts = rows.filter((r) => r.status === "PUBLISHED").length;
  const postsWithoutLinks = rows.filter((r) => r.totalLinks === 0).length;
  const postsWithFaqs = rows.filter((r) => r.faqSource !== "none").length;
  const postsNotIndexed = rows.filter(
    (r) => r.indexState === "discovered_not_indexed" || r.indexState === "crawled_not_indexed"
  ).length;

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-foreground">Blog coverage</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Per-post link footprint, FAQ source, and Google indexation status. Sortable; default sort
          is total link count descending. Indexation data comes from{" "}
          <code>gsc_inspection_state</code> populated by the URL Inspection sweep.
        </p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="Posts" value={totalPosts} />
        <Stat label="Published" value={publishedPosts} />
        <Stat label="Zero links" value={postsWithoutLinks} accent="amber" />
        <Stat label="With FAQ" value={postsWithFaqs} />
        <Stat label="Not indexed" value={postsNotIndexed} accent="red" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Posts</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-muted border-b border-border">
                <tr>
                  <SortHeader label="title" k="title" active={sort} />
                  <SortHeader label="publish" k="publishDate" active={sort} />
                  <SortHeader label="links" k="totalLinks" active={sort} align="right" />
                  <SortHeader label="event" k="eventLinks" active={sort} align="right" />
                  <SortHeader label="vendor" k="vendorLinks" active={sort} align="right" />
                  <SortHeader label="venue" k="venueLinks" active={sort} align="right" />
                  <SortHeader label="faq" k="faqSource" active={sort} />
                  <SortHeader label="indexation" k="indexState" active={sort} />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-6 text-center text-muted-foreground">
                      No blog posts.
                    </td>
                  </tr>
                )}
                {rows.map((r) => {
                  const faqMeta = faqSourceChip(r.faqSource);
                  const indexMeta = indexStateChip(r.indexState);
                  return (
                    <tr key={r.id} className="border-b border-border hover:bg-muted">
                      <td className="px-4 py-2">
                        <Link
                          href={`/blog/${r.slug}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-royal hover:underline"
                        >
                          {r.title}
                        </Link>
                        <div className="text-xs text-muted-foreground font-mono">{r.slug}</div>
                        {r.status === "DRAFT" && (
                          <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium border bg-muted text-muted-foreground border-border">
                            DRAFT
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-foreground tabular-nums">
                        {formatDate(r.publishDate)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium text-foreground">
                        {r.totalLinks === 0 ? (
                          <span className="text-amber-700">{r.totalLinks}</span>
                        ) : (
                          r.totalLinks
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-foreground">
                        {r.eventLinks}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-foreground">
                        {r.vendorLinks}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-foreground">
                        {r.venueLinks}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border ${faqMeta.cls}`}
                        >
                          {faqMeta.label}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        <span
                          title={r.coverageState ?? undefined}
                          className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border ${indexMeta.cls}`}
                        >
                          {indexMeta.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Indexation status reflects the most recent URL Inspection sweep run. Rows in{" "}
        <span className="text-red-700">discovered, not indexed</span> or{" "}
        <span className="text-amber-700">crawled, not indexed</span> are candidates for{" "}
        <code>request_indexing</code> (MCP) or content rewrites.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: "amber" | "red";
}) {
  const cls =
    accent === "red" ? "text-red-700" : accent === "amber" ? "text-amber-700" : "text-foreground";
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-2xl font-semibold tabular-nums mt-1 ${cls}`}>{value}</p>
      </CardContent>
    </Card>
  );
}
