import type { Metadata } from "next";
import Link from "next/link";
import { FileText } from "lucide-react";
import { getCloudflareDb } from "@/lib/cloudflare";
import { blogPosts, users } from "@/lib/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { BlogPostCard } from "@/components/blog/blog-post-card";
import { Badge } from "@/components/ui/badge";
import { ItemListSchema } from "@/components/seo/ItemListSchema";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { extractFirstImage } from "@/lib/markdown-utils";
import { formatAuthorName } from "@/lib/utils";

export const runtime = "edge";
export const revalidate = 300;

export const metadata: Metadata = {
  title: "Blog | Meet Me at the Fair",
  description:
    "Stories, tips, and news about fairs, festivals, and community events across New England.",
  alternates: {
    canonical: "https://meetmeatthefair.com/blog",
    types: {
      "application/rss+xml": "https://meetmeatthefair.com/blog/feed.xml",
    },
  },
  openGraph: {
    title: "Blog | Meet Me at the Fair",
    description:
      "Stories, tips, and news about fairs, festivals, and community events across New England.",
    url: "https://meetmeatthefair.com/blog",
    siteName: "Meet Me at the Fair",
    type: "website",
    images: [
      {
        url: "https://meetmeatthefair.com/og-default.png",
        width: 1200,
        height: 630,
        alt: "Meet Me at the Fair Blog",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Blog | Meet Me at the Fair",
    description:
      "Stories, tips, and news about fairs, festivals, and community events across New England.",
    images: ["https://meetmeatthefair.com/og-default.png"],
  },
};

interface SearchParams {
  tag?: string;
  page?: string;
}

const POSTS_PER_PAGE = 12;

export default async function BlogPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const session = await auth();
  const isAdmin = session?.user?.role === "ADMIN";
  const db = getCloudflareDb();

  const page = Math.max(1, parseInt(params.page || "1", 10));
  const offset = (page - 1) * POSTS_PER_PAGE;

  const conditions = [];
  if (!isAdmin) {
    conditions.push(eq(blogPosts.status, "PUBLISHED"));
  }

  if (params.tag) {
    const safeTag = params.tag.replace(/["%_\\]/g, "");
    conditions.push(sql`${blogPosts.tags} LIKE ${'%"' + safeTag + '"%'}`);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [posts, countResult] = await Promise.all([
    db
      .select({
        id: blogPosts.id,
        title: blogPosts.title,
        slug: blogPosts.slug,
        body: blogPosts.body,
        excerpt: blogPosts.excerpt,
        authorName: users.name,
        tags: blogPosts.tags,
        categories: blogPosts.categories,
        featuredImageUrl: blogPosts.featuredImageUrl,
        status: blogPosts.status,
        publishDate: blogPosts.publishDate,
      })
      .from(blogPosts)
      .leftJoin(users, eq(blogPosts.authorId, users.id))
      .where(where)
      .orderBy(desc(blogPosts.publishDate))
      .limit(POSTS_PER_PAGE)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(blogPosts)
      .where(where),
  ]);

  const total = countResult[0].count;
  const totalPages = Math.ceil(total / POSTS_PER_PAGE);

  const parsedPosts = posts.map((p) => ({
    ...p,
    authorName: formatAuthorName(p.authorName),
    tags: JSON.parse(p.tags || "[]") as string[],
    categories: JSON.parse(p.categories || "[]") as string[],
    featuredImageUrl: p.featuredImageUrl || extractFirstImage(p.body),
  }));

  // Collect all unique tags for the filter sidebar
  const allTagsResult = isAdmin
    ? await db.select({ tags: blogPosts.tags }).from(blogPosts)
    : await db
        .select({ tags: blogPosts.tags })
        .from(blogPosts)
        .where(eq(blogPosts.status, "PUBLISHED"));

  // A6 (2026-06-04) — rank tags by frequency. Previously we rendered every
  // unique tag inline (~300+ post-content-batches), which made the sidebar
  // sluggish and the choice paradoxical (no signal about which tags have
  // many posts). Show top-N most-frequent inline; collapse the long tail
  // behind a `<details>` element so the markup is still present (SEO +
  // bot-discoverable) but not rendered eagerly.
  const TAGS_INLINE_LIMIT = 20;
  const tagFrequency = new Map<string, number>();
  for (const r of allTagsResult) {
    for (const tag of JSON.parse(r.tags || "[]") as string[]) {
      tagFrequency.set(tag, (tagFrequency.get(tag) ?? 0) + 1);
    }
  }
  const rankedTags = [...tagFrequency.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
  // Keep the currently-active tag at the top of the inline list even if
  // it's not in the top-N by frequency — otherwise selecting a rare tag
  // makes the "active" chip vanish into the collapsed section.
  const activeTag = params.tag;
  const inlineTagSet = new Set(rankedTags.slice(0, TAGS_INLINE_LIMIT));
  if (activeTag && !inlineTagSet.has(activeTag) && rankedTags.includes(activeTag)) {
    inlineTagSet.add(activeTag);
  }
  const inlineTags = rankedTags.filter((t) => inlineTagSet.has(t));
  const overflowTags = rankedTags.filter((t) => !inlineTagSet.has(t));
  // (Previously kept a flat sorted `allTags` list — render now consumes
  //  `rankedTags` / `inlineTags` / `overflowTags` exclusively.)

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Blog", url: "https://meetmeatthefair.com/blog" },
        ]}
      />
      {parsedPosts.length > 0 && (
        <ItemListSchema
          name="Blog | Meet Me at the Fair"
          description="Stories, tips, and news about fairs, festivals, and community events across New England."
          items={parsedPosts.map((p) => ({
            name: p.title,
            url: `https://meetmeatthefair.com/blog/${p.slug}`,
            image: p.featuredImageUrl,
          }))}
          totalCount={total}
          positionStart={(page - 1) * POSTS_PER_PAGE + 1}
          order="descending"
          asCollectionPage
          pageUrl="https://meetmeatthefair.com/blog"
        />
      )}

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-navy">Blog</h1>
        <p className="mt-2 text-muted-foreground">
          Stories, tips, and news about fairs, festivals, and community events.
        </p>
        {isAdmin && (
          <div className="mt-2">
            <Badge variant="info">Admin view — showing all posts including drafts</Badge>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        {/* Sidebar — tags filter */}
        {rankedTags.length > 0 && (
          <aside className="lg:col-span-1">
            <div className="bg-card rounded-lg border border-border p-4 sticky top-24">
              <h2 className="text-sm font-semibold text-navy mb-3">Filter by Tag</h2>
              <div className="flex flex-wrap gap-2">
                {params.tag && (
                  <Link
                    href="/blog"
                    className="text-xs px-3 py-1 bg-secondary text-secondary-foreground rounded-full hover:bg-royal/90"
                  >
                    All posts
                  </Link>
                )}
                {inlineTags.map((tag) => (
                  <Link
                    key={tag}
                    href={`/blog?tag=${encodeURIComponent(tag)}`}
                    className={`text-xs px-3 py-1 rounded-full transition-colors ${
                      params.tag === tag
                        ? "bg-secondary text-secondary-foreground"
                        : "bg-muted text-foreground hover:bg-muted"
                    }`}
                  >
                    {tag}
                  </Link>
                ))}
              </div>
              {overflowTags.length > 0 && (
                <details className="mt-3">
                  <summary className="text-xs text-foreground cursor-pointer hover:text-navy select-none">
                    Browse all {rankedTags.length} tags ({overflowTags.length} more)
                  </summary>
                  <div className="flex flex-wrap gap-2 mt-3">
                    {overflowTags.map((tag) => (
                      <Link
                        key={tag}
                        href={`/blog?tag=${encodeURIComponent(tag)}`}
                        className={`text-xs px-3 py-1 rounded-full transition-colors ${
                          params.tag === tag
                            ? "bg-secondary text-secondary-foreground"
                            : "bg-muted text-foreground hover:bg-muted"
                        }`}
                      >
                        {tag}
                      </Link>
                    ))}
                  </div>
                </details>
              )}
            </div>
          </aside>
        )}

        {/* Posts grid */}
        <div className={rankedTags.length > 0 ? "lg:col-span-3" : "lg:col-span-4"}>
          {parsedPosts.length === 0 ? (
            <div className="text-center py-16">
              <FileText className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
              <h2 className="text-lg font-medium text-muted-foreground">No blog posts yet</h2>
              <p className="text-sm text-muted-foreground mt-1">
                {params.tag
                  ? `No posts found with tag "${params.tag}".`
                  : "Check back soon for stories and updates."}
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                {parsedPosts.map((post, i) => (
                  // IMG-followup (2026-06-08) — exactly one preload per page
                  // (i === 0). Earlier eagerLoad attempt reverted: in
                  // Next.js 15.x loading="eager" emits preload too, so it
                  // recreated the 3-preload multi-priority bug it was
                  // meant to prevent. Default lazy is correct for non-LCP.
                  <BlogPostCard key={post.id} post={post} priority={i === 0} />
                ))}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex justify-center gap-2 mt-8">
                  {page > 1 && (
                    <Link
                      href={`/blog?page=${page - 1}${params.tag ? `&tag=${encodeURIComponent(params.tag)}` : ""}`}
                      className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-muted"
                    >
                      Previous
                    </Link>
                  )}
                  <span className="px-4 py-2 text-sm text-muted-foreground">
                    Page {page} of {totalPages}
                  </span>
                  {page < totalPages && (
                    <Link
                      href={`/blog?page=${page + 1}${params.tag ? `&tag=${encodeURIComponent(params.tag)}` : ""}`}
                      className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-muted"
                    >
                      Next
                    </Link>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
