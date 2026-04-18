import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { getCloudflareDb } from "@/lib/cloudflare";
import { blogPosts, contentLinks, events, vendors, venues } from "@/lib/db/schema";
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

export interface LinkedEntity {
  slug: string;
  name: string;
}

export interface EntitiesLinkedFromPost {
  events: LinkedEntity[];
  vendors: LinkedEntity[];
  venues: LinkedEntity[];
}

/**
 * Reverse of getDirectlyLinkedBlogPosts: given a blog post ID, return the
 * events/vendors/venues it directly links to. Only resolved links (i.e. the
 * target slug existed when the post was saved) are returned — broken links
 * can't be followed, so they'd be dead sidebar entries.
 *
 * Runs three small lookups rather than a union, because each entity type
 * joins a different name column (events.name vs vendors.businessName vs
 * venues.name).
 */
export async function getEntitiesLinkedFromPost(
  db: ReturnType<typeof getCloudflareDb>,
  blogPostId: string
): Promise<EntitiesLinkedFromPost> {
  try {
    const [evtRows, vndRows, vnuRows] = await Promise.all([
      db
        .select({ slug: events.slug, name: events.name })
        .from(contentLinks)
        .innerJoin(events, eq(contentLinks.targetId, events.id))
        .where(
          and(
            eq(contentLinks.sourceType, "BLOG_POST"),
            eq(contentLinks.sourceId, blogPostId),
            eq(contentLinks.targetType, "EVENT"),
            isNotNull(contentLinks.targetId)
          )
        )
        .orderBy(events.name),
      db
        .select({ slug: vendors.slug, name: vendors.businessName })
        .from(contentLinks)
        .innerJoin(vendors, eq(contentLinks.targetId, vendors.id))
        .where(
          and(
            eq(contentLinks.sourceType, "BLOG_POST"),
            eq(contentLinks.sourceId, blogPostId),
            eq(contentLinks.targetType, "VENDOR"),
            isNotNull(contentLinks.targetId)
          )
        )
        .orderBy(vendors.businessName),
      db
        .select({ slug: venues.slug, name: venues.name })
        .from(contentLinks)
        .innerJoin(venues, eq(contentLinks.targetId, venues.id))
        .where(
          and(
            eq(contentLinks.sourceType, "BLOG_POST"),
            eq(contentLinks.sourceId, blogPostId),
            eq(contentLinks.targetType, "VENUE"),
            isNotNull(contentLinks.targetId)
          )
        )
        .orderBy(venues.name),
    ]);
    return { events: evtRows, vendors: vndRows, venues: vnuRows };
  } catch {
    return { events: [], vendors: [], venues: [] };
  }
}
