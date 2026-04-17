import { inArray } from "drizzle-orm";
import { blogPosts } from "@/lib/db/schema";
import type { getCloudflareDb } from "@/lib/cloudflare";

// Match /blog/<slug> occurrences (hrefs, markdown links, bare text).
const BLOG_LINK_RE = /\/blog\/([a-z0-9][a-z0-9-]*)(?=[^a-z0-9-]|$)/gi;

/**
 * Extract every /blog/<slug> reference from a post body. Dedupes, lowercases.
 */
export function extractBlogLinks(body: string | null | undefined): string[] {
  if (!body) return [];
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(BLOG_LINK_RE.source, BLOG_LINK_RE.flags);
  while ((match = re.exec(body)) !== null) {
    const slug = match[1].toLowerCase();
    if (slug) found.add(slug);
  }
  return Array.from(found);
}

/**
 * Given a body and the set of published slugs, return any referenced slugs
 * that don't exist.
 */
export function findBrokenLinks(body: string, publishedSlugs: Iterable<string>): string[] {
  const valid = new Set<string>();
  for (const s of publishedSlugs) valid.add(s.toLowerCase());
  return extractBlogLinks(body).filter((s) => !valid.has(s));
}

/**
 * DB-aware broken-link check. Reads the slugs for every slug referenced in
 * the body, then returns any that were missing.
 */
export async function findBrokenLinksInDb(
  db: ReturnType<typeof getCloudflareDb>,
  body: string
): Promise<string[]> {
  const referenced = extractBlogLinks(body);
  if (referenced.length === 0) return [];
  const rows = await db
    .select({ slug: blogPosts.slug })
    .from(blogPosts)
    .where(inArray(blogPosts.slug, referenced));
  const known = new Set(rows.map((r) => r.slug.toLowerCase()));
  return referenced.filter((s) => !known.has(s));
}
