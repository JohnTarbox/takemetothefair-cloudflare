/**
 * Category/tag-matched blog posts for an event page's "related posts" block —
 * the topical fallback used once the guide and directly-linked posts are in.
 *
 * ── OPE-1376: why containsCI, and why the error is no longer swallowed ──
 *
 * This used to be `like(blogPosts.tags, \`%${eventName}%\`)`. D1 throws
 * `LIKE or GLOB pattern too complex` once a pattern passes 50 characters, so
 * every event whose name is longer than ~48 characters threw here — and the
 * caller's bare `catch { return [] }` turned that into "no related posts".
 * Measured on prod for OPE-1355: 158 of 1,562 live events. Local SQLite's cap
 * is 50,000, so no test saw it.
 *
 * `containsCI` compiles to `instr(lower(col), ?) > 0`: same substring match,
 * no pattern ceiling. A failure still degrades to an empty list (a related-
 * posts block is not worth a 500 on the event page), but it is now logged so
 * the next one is visible.
 */
import { and, desc, eq, or } from "drizzle-orm";
import { blogPosts } from "@/lib/db/schema";
import { containsCI } from "@/lib/db/contains-ci";
import { logError } from "@/lib/logger";
import type { getCloudflareDb } from "@/lib/cloudflare";

type Db = ReturnType<typeof getCloudflareDb>;

export interface CategoryMatchedPost {
  title: string;
  slug: string;
  excerpt: string | null;
  publishDate: Date | null;
  kind: "category";
}

export async function getCategoryMatchedBlogPosts(
  db: Db,
  eventName: string,
  categories: string[],
  excludeSlugs: string[],
  limit: number
): Promise<CategoryMatchedPost[]> {
  if (limit <= 0) return [];
  try {
    const searchConditions = [
      containsCI(blogPosts.tags, eventName),
      ...categories.map((cat) => containsCI(blogPosts.tags, cat)),
      ...categories.map((cat) => containsCI(blogPosts.categories, cat)),
    ];

    const posts = await db
      .select({
        title: blogPosts.title,
        slug: blogPosts.slug,
        excerpt: blogPosts.excerpt,
        publishDate: blogPosts.publishDate,
      })
      .from(blogPosts)
      .where(and(eq(blogPosts.status, "PUBLISHED"), or(...searchConditions)))
      .orderBy(desc(blogPosts.publishDate))
      .limit(limit + excludeSlugs.length);

    const excluded = new Set(excludeSlugs);
    return posts
      .filter((p) => !excluded.has(p.slug))
      .slice(0, limit)
      .map((p) => ({ ...p, kind: "category" as const }));
  } catch (e) {
    await logError(db, {
      message: "Error fetching category-matched blog posts",
      error: e,
      source: "lib/blog/category-matched-posts.ts:getCategoryMatchedBlogPosts",
      context: { eventName, categoryCount: categories.length },
    });
    return [];
  }
}
