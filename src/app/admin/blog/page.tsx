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
import { getCloudflareDb } from "@/lib/cloudflare";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BlogIndexBackfillButton } from "@/components/admin/blog-index-backfill-button";
import { type BlogFaqSource } from "@takemetothefair/utils";
import { type IndexState } from "@/lib/gsc-index-state";
import {
  loadBlogCoverageRows,
  blogClusterRollup,
  BLOG_GSC_WINDOW_DAYS,
  type PostRow,
  type ClusterRollupRow,
} from "@/lib/admin/blog-coverage";

export const revalidate = 300;

type SortKey =
  | "title"
  | "publishDate"
  | "clicks"
  | "impressions"
  | "ctr"
  | "ageWeeks"
  | "totalLinks"
  | "eventLinks"
  | "vendorLinks"
  | "venueLinks"
  | "faqSource"
  | "indexState"
  | "bingIndexState";

const SORT_VALUES: SortKey[] = [
  "title",
  "publishDate",
  "clicks",
  "impressions",
  "ctr",
  "ageWeeks",
  "totalLinks",
  "eventLinks",
  "vendorLinks",
  "venueLinks",
  "faqSource",
  "indexState",
  "bingIndexState",
];

// The cluster rollup panel sorts independently of the post table, via its own
// `csort` query param so the two don't clobber each other.
type ClusterSortKey = "clicks" | "clicksPerPost" | "posts" | "impressions" | "internalLinks";

const CLUSTER_SORT_VALUES: ClusterSortKey[] = [
  "clicks",
  "clicksPerPost",
  "posts",
  "impressions",
  "internalLinks",
];

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
    case "clicks":
      return [...rows].sort((a, b) => b.clicks - a.clicks || tieBreak(a, b));
    case "impressions":
      return [...rows].sort((a, b) => b.impressions - a.impressions || tieBreak(a, b));
    case "ctr":
      return [...rows].sort((a, b) => b.ctr - a.ctr || tieBreak(a, b));
    case "ageWeeks":
      // Oldest first — a 0-click mature post is the one to scrutinize; young
      // posts (null age sorts last) are still maturing.
      return [...rows].sort((a, b) => (b.ageWeeks ?? -1) - (a.ageWeeks ?? -1) || tieBreak(a, b));
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
    case "bingIndexState": {
      // not-indexed first (actionable), then unknown, then indexed — mirroring
      // the indexState ordering. null=unknown, false=not indexed, true=indexed.
      const rank = (v: boolean | null): number => (v === false ? 0 : v === null ? 1 : 2);
      return [...rows].sort((a, b) => rank(a.bingIndexed) - rank(b.bingIndexed) || tieBreak(a, b));
    }
  }
}

function sortClusterRows(rows: ClusterRollupRow[], key: ClusterSortKey): ClusterRollupRow[] {
  // All numeric, descending. Tiebreaker = cluster name ascending for stability.
  const tieBreak = (a: ClusterRollupRow, b: ClusterRollupRow) => a.cluster.localeCompare(b.cluster);
  const byNumberDesc = (pick: (r: ClusterRollupRow) => number) =>
    [...rows].sort((a, b) => pick(b) - pick(a) || tieBreak(a, b));
  switch (key) {
    case "clicks":
      return byNumberDesc((r) => r.clicks);
    case "clicksPerPost":
      return byNumberDesc((r) => r.clicksPerPost);
    case "posts":
      return byNumberDesc((r) => r.posts);
    case "impressions":
      return byNumberDesc((r) => r.impressions);
    case "internalLinks":
      return byNumberDesc((r) => r.internalLinks);
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

function bingChip(indexed: boolean | null): { label: string; cls: string } {
  if (indexed === true) {
    return { label: "indexed", cls: "bg-green-50 text-green-800 border-green-200" };
  }
  if (indexed === false) {
    return { label: "not indexed", cls: "bg-red-50 text-red-800 border-red-300" };
  }
  return { label: "unknown", cls: "bg-muted text-muted-foreground border-border" };
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

// SEO takes ~8–12 weeks; treat < 10 weeks as "maturing" so a young 0-click
// post isn't misjudged against a stale one. null age = no publish date.
const MATURE_WEEKS = 10;

function formatAge(weeks: number | null): { label: string; maturing: boolean } {
  if (weeks === null) return { label: "—", maturing: false };
  const maturing = weeks < MATURE_WEEKS;
  return { label: `${weeks}w · ${maturing ? "maturing" : "mature"}`, maturing };
}

function formatCtr(ctr: number): string {
  return `${(ctr * 100).toFixed(1)}%`;
}

interface SortHeaderProps {
  label: string;
  k: SortKey;
  active: SortKey;
  csort: ClusterSortKey;
  align?: "left" | "right";
}

function SortHeader({ label, k, active, csort, align = "left" }: SortHeaderProps) {
  const isActive = active === k;
  return (
    <th className={`px-4 py-2 font-medium ${align === "right" ? "text-right" : "text-left"}`}>
      <Link
        href={`/admin/blog?sort=${k}&csort=${csort}`}
        className={`hover:text-foreground ${isActive ? "text-foreground font-semibold" : "text-muted-foreground"}`}
      >
        {label}
        {isActive ? " ▾" : ""}
      </Link>
    </th>
  );
}

interface ClusterSortHeaderProps {
  label: string;
  k: ClusterSortKey;
  active: ClusterSortKey;
  sort: SortKey;
  align?: "left" | "right";
}

function ClusterSortHeader({ label, k, active, sort, align = "left" }: ClusterSortHeaderProps) {
  const isActive = active === k;
  return (
    <th className={`px-4 py-2 font-medium ${align === "right" ? "text-right" : "text-left"}`}>
      <Link
        href={`/admin/blog?sort=${sort}&csort=${k}`}
        className={`hover:text-foreground ${isActive ? "text-foreground font-semibold" : "text-muted-foreground"}`}
      >
        {label}
        {isActive ? " ▾" : ""}
      </Link>
    </th>
  );
}

export const dynamic = "force-dynamic";

export default async function BlogCoveragePage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; csort?: string }>;
}) {
  const sp = await searchParams;
  const sort: SortKey = SORT_VALUES.includes(sp.sort as SortKey)
    ? (sp.sort as SortKey)
    : "totalLinks";
  const csort: ClusterSortKey = CLUSTER_SORT_VALUES.includes(sp.csort as ClusterSortKey)
    ? (sp.csort as ClusterSortKey)
    : "clicks";

  const allRows = await loadBlogCoverageRows(getCloudflareDb());
  const rows = sortRows(allRows, sort);
  const clusterRows = sortClusterRows(blogClusterRollup(allRows), csort);

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
          Per-post reach (clicks/impressions/CTR), age, link footprint, FAQ source, and Google/Bing
          indexation status, plus a per-cluster effectiveness rollup. Sortable; default sort is
          total link count descending. Indexation data comes from <code>gsc_inspection_state</code>{" "}
          populated by the URL Inspection sweep.
        </p>
        <div className="mt-3">
          <BlogIndexBackfillButton />
        </div>
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
          <CardTitle className="text-sm font-semibold">Effectiveness by cluster</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            The ~113 posts collapsed into topic buckets by a <strong>v1 slug/tag heuristic</strong>{" "}
            ( <code>src/lib/admin/blog-clusters.ts</code>) — directional, not an exact match to a
            manual grouping (edge posts with &quot;fair&quot;/&quot;festival&quot; in the slug may
            land a bucket off; tune the rules or supply a canonical slug→cluster map). Sortable.
            Clicks &amp; impressions are GSC-sampled (top query×page) over the last{" "}
            {BLOG_GSC_WINDOW_DAYS} days — they under-count the tail. Internal links = event + vendor
            + venue links each cluster distributes.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-muted border-b border-border">
                <tr>
                  <th className="px-4 py-2 font-medium text-left text-muted-foreground">cluster</th>
                  <ClusterSortHeader
                    label="posts"
                    k="posts"
                    active={csort}
                    sort={sort}
                    align="right"
                  />
                  <ClusterSortHeader
                    label="clicks"
                    k="clicks"
                    active={csort}
                    sort={sort}
                    align="right"
                  />
                  <ClusterSortHeader
                    label="clicks/post"
                    k="clicksPerPost"
                    active={csort}
                    sort={sort}
                    align="right"
                  />
                  <ClusterSortHeader
                    label="impr"
                    k="impressions"
                    active={csort}
                    sort={sort}
                    align="right"
                  />
                  <ClusterSortHeader
                    label="int. links"
                    k="internalLinks"
                    active={csort}
                    sort={sort}
                    align="right"
                  />
                </tr>
              </thead>
              <tbody>
                {clusterRows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                      No blog posts.
                    </td>
                  </tr>
                )}
                {clusterRows.map((c) => (
                  <tr key={c.cluster} className="border-b border-border hover:bg-muted">
                    <td className="px-4 py-2 text-foreground">{c.cluster}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                      {c.posts}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-medium text-foreground">
                      {c.clicks}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-foreground">
                      {c.clicksPerPost.toFixed(1)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                      {c.impressions}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-foreground">
                      {c.internalLinks}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Posts</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-muted border-b border-border">
                <tr>
                  <SortHeader label="title" k="title" active={sort} csort={csort} />
                  <SortHeader label="publish" k="publishDate" active={sort} csort={csort} />
                  <SortHeader label="clicks" k="clicks" active={sort} csort={csort} align="right" />
                  <SortHeader
                    label="impr"
                    k="impressions"
                    active={sort}
                    csort={csort}
                    align="right"
                  />
                  <SortHeader label="ctr" k="ctr" active={sort} csort={csort} align="right" />
                  <SortHeader label="age" k="ageWeeks" active={sort} csort={csort} />
                  <SortHeader
                    label="links"
                    k="totalLinks"
                    active={sort}
                    csort={csort}
                    align="right"
                  />
                  <SortHeader
                    label="event"
                    k="eventLinks"
                    active={sort}
                    csort={csort}
                    align="right"
                  />
                  <SortHeader
                    label="vendor"
                    k="vendorLinks"
                    active={sort}
                    csort={csort}
                    align="right"
                  />
                  <SortHeader
                    label="venue"
                    k="venueLinks"
                    active={sort}
                    csort={csort}
                    align="right"
                  />
                  <SortHeader label="faq" k="faqSource" active={sort} csort={csort} />
                  <SortHeader label="google" k="indexState" active={sort} csort={csort} />
                  <SortHeader label="bing" k="bingIndexState" active={sort} csort={csort} />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={13} className="px-4 py-6 text-center text-muted-foreground">
                      No blog posts.
                    </td>
                  </tr>
                )}
                {rows.map((r) => {
                  const faqMeta = faqSourceChip(r.faqSource);
                  const indexMeta = indexStateChip(r.indexState);
                  const bingMeta = bingChip(r.bingIndexed);
                  const bingCrawled = r.bingLastCrawled
                    ? formatDate(new Date(r.bingLastCrawled))
                    : null;
                  const age = formatAge(r.ageWeeks);
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
                        <div className="mt-0.5">
                          {/* B4-3 — focal-point picker for the featured image. */}
                          <Link
                            href={`/admin/blog/${r.slug}/edit`}
                            className="text-xs text-muted-foreground hover:text-royal hover:underline"
                          >
                            Edit focal point
                          </Link>
                        </div>
                      </td>
                      <td className="px-4 py-2 text-foreground tabular-nums">
                        {formatDate(r.publishDate)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-foreground">
                        {r.clicks}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                        {r.impressions}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                        {r.impressions > 0 ? formatCtr(r.ctr) : "—"}
                      </td>
                      <td className="px-4 py-2 tabular-nums">
                        <span
                          className={age.maturing ? "text-muted-foreground" : "text-foreground"}
                        >
                          {age.label}
                        </span>
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
                      <td className="px-4 py-2">
                        <span
                          title={r.bingCrawlError ?? undefined}
                          className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border ${bingMeta.cls}`}
                        >
                          {bingMeta.label}
                        </span>
                        {bingCrawled && (
                          <div className="text-[10px] text-muted-foreground tabular-nums mt-0.5">
                            {bingCrawled}
                          </div>
                        )}
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
        GSC clicks/impressions are sampled (top query×page) over the last {BLOG_GSC_WINDOW_DAYS}{" "}
        days, so they under-count the tail; recent days also lag in GSC reporting. Age flags posts
        younger than {MATURE_WEEKS} weeks as still maturing (SEO takes ~8–12 weeks), so a young
        0-click post isn&apos;t misjudged against a mature one. Indexation status reflects the most
        recent URL Inspection sweep run. Rows in{" "}
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
