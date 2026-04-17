import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Tag } from "lucide-react";
import { getCloudflareDb } from "@/lib/cloudflare";
import { blogPosts, users } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { BlogPostCard } from "@/components/blog/blog-post-card";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { extractFirstImage } from "@/lib/markdown-utils";
import { formatAuthorName } from "@/lib/utils";

export const runtime = "edge";
export const revalidate = 600; // 10 minutes

interface Props {
  params: Promise<{ tag: string }>;
}

function tagToUrlSlug(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function getPostsByTagSlug(tagSlug: string) {
  const db = getCloudflareDb();
  const rows = await db
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
    .where(and(eq(blogPosts.status, "PUBLISHED")))
    .orderBy(desc(blogPosts.publishDate));

  const matches: typeof rows = [];
  let displayName: string | null = null;
  for (const p of rows) {
    let tagsArr: string[] = [];
    try {
      tagsArr = JSON.parse(p.tags || "[]") as string[];
    } catch {
      tagsArr = [];
    }
    const hit = tagsArr.find((t) => tagToUrlSlug(t) === tagSlug);
    if (hit) {
      matches.push(p);
      if (!displayName) displayName = hit;
    }
  }
  return { posts: matches, displayName };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { tag } = await params;
  const tagSlug = decodeURIComponent(tag).toLowerCase();
  const { displayName, posts } = await getPostsByTagSlug(tagSlug);
  const name = displayName ?? tagSlug;
  const url = `https://meetmeatthefair.com/blog/tag/${tagSlug}`;
  const description = `Blog posts tagged "${name}" — ${posts.length} article${posts.length === 1 ? "" : "s"} about fairs, vendors, and events in New England.`;
  return {
    title: `${name} — Blog | Meet Me at the Fair`,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: `${name} — Meet Me at the Fair Blog`,
      description,
      url,
      type: "website",
    },
  };
}

export default async function BlogTagPage({ params }: Props) {
  const { tag } = await params;
  const tagSlug = decodeURIComponent(tag).toLowerCase();
  const { posts, displayName } = await getPostsByTagSlug(tagSlug);

  if (posts.length === 0 || !displayName) {
    notFound();
  }

  const parsedPosts = posts.map((p) => ({
    ...p,
    authorName: formatAuthorName(p.authorName),
    tags: (() => {
      try {
        return JSON.parse(p.tags || "[]") as string[];
      } catch {
        return [];
      }
    })(),
    categories: (() => {
      try {
        return JSON.parse(p.categories || "[]") as string[];
      } catch {
        return [];
      }
    })(),
    featuredImageUrl: p.featuredImageUrl || extractFirstImage(p.body),
  }));

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Blog", url: "https://meetmeatthefair.com/blog" },
          { name: displayName, url: `https://meetmeatthefair.com/blog/tag/${tagSlug}` },
        ]}
      />

      <Link
        href="/blog"
        className="inline-flex items-center gap-1 text-sm text-navy hover:underline mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Blog
      </Link>

      <div className="mb-8">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-terracotta-light text-stone-900 text-sm font-medium mb-3">
          <Tag className="w-3.5 h-3.5" />
          {displayName}
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold text-navy">
          Posts tagged &ldquo;{displayName}&rdquo;
        </h1>
        <p className="mt-2 text-gray-600">
          {posts.length} article{posts.length === 1 ? "" : "s"}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {parsedPosts.map((post) => (
          <BlogPostCard key={post.id} post={post} />
        ))}
      </div>
    </div>
  );
}
