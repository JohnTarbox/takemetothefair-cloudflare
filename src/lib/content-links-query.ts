import { and, desc, eq } from "drizzle-orm";
import type { getCloudflareDb } from "@/lib/cloudflare";
import { blogPosts, contentLinks } from "@/lib/db/schema";
import type { ContentLinkTargetType } from "@/lib/blog-links";

export interface LinkedBlogPost {
  title: string;
  slug: string;
  excerpt: string | null;
  publishDate: Date | null;
}

/**
 * Published blog posts that directly link to the given entity via
 * /events/<slug>, /vendors/<slug>, or /venues/<slug>. Joined through
 * content_links so queries are O(direct-links), not O(posts).
 */
export async function getDirectlyLinkedBlogPosts(
  db: ReturnType<typeof getCloudflareDb>,
  targetType: ContentLinkTargetType,
  targetId: string,
  limit = 3
): Promise<LinkedBlogPost[]> {
  if (limit <= 0) return [];
  try {
    const rows = await db
      .select({
        title: blogPosts.title,
        slug: blogPosts.slug,
        excerpt: blogPosts.excerpt,
        publishDate: blogPosts.publishDate,
      })
      .from(contentLinks)
      .innerJoin(blogPosts, eq(contentLinks.sourceId, blogPosts.id))
      .where(
        and(
          eq(contentLinks.sourceType, "BLOG_POST"),
          eq(contentLinks.targetType, targetType),
          eq(contentLinks.targetId, targetId),
          eq(blogPosts.status, "PUBLISHED")
        )
      )
      .orderBy(desc(blogPosts.publishDate))
      .limit(limit);
    return rows;
  } catch {
    return [];
  }
}
