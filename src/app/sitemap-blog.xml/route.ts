export const dynamic = "force-dynamic";
import { eq } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { blogPosts } from "@/lib/db/schema";
import {
  SITEMAP_BASE_URL,
  safeLastMod,
  serializeUrlset,
  sitemapXmlHeaders,
  type SitemapUrl,
} from "@/lib/sitemap-xml";

// Slug must mirror /blog/tag/[tag]/page.tsx — kept inline rather than
// imported because that page's helper isn't exported, and dragging in the
// rendering deps for a slugify here would be heavier than 5 lines of regex.
function tagToSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function buildBlogUrls(): Promise<SitemapUrl[]> {
  const db = getCloudflareDb();
  const posts = await db
    .select({
      slug: blogPosts.slug,
      updatedAt: blogPosts.updatedAt,
      tags: blogPosts.tags,
    })
    .from(blogPosts)
    .where(eq(blogPosts.status, "PUBLISHED"));

  const postPages: SitemapUrl[] = posts.map((post) => ({
    url: `${SITEMAP_BASE_URL}/blog/${post.slug}`,
    lastModified: safeLastMod(post.updatedAt),
    changeFrequency: "weekly",
    priority: 0.6,
  }));

  // Collect tag → most-recent-post-lastmod so tag landing pages get a
  // sensible <lastmod>. One URL per unique tag slug.
  const tagSlugToLastMod = new Map<string, Date>();
  for (const post of posts) {
    let tagsArr: string[] = [];
    try {
      tagsArr = JSON.parse(post.tags || "[]") as string[];
    } catch {
      tagsArr = [];
    }
    const postMod = safeLastMod(post.updatedAt);
    for (const raw of tagsArr) {
      const slug = tagToSlug(raw);
      if (!slug) continue;
      const existing = tagSlugToLastMod.get(slug);
      if (!existing || postMod > existing) tagSlugToLastMod.set(slug, postMod);
    }
  }

  const tagPages: SitemapUrl[] = Array.from(tagSlugToLastMod.entries()).map(([slug, lastMod]) => ({
    url: `${SITEMAP_BASE_URL}/blog/tag/${slug}`,
    lastModified: lastMod,
    changeFrequency: "weekly",
    priority: 0.4,
  }));

  return [...postPages, ...tagPages];
}

export async function GET(): Promise<Response> {
  try {
    return new Response(serializeUrlset(await buildBlogUrls()), {
      headers: sitemapXmlHeaders(3600),
    });
  } catch (error) {
    console.error("sitemap-blog: D1 query failed", error);
    return new Response(serializeUrlset([]), { headers: sitemapXmlHeaders(60) });
  }
}
