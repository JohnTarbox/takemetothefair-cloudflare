import { inArray } from "drizzle-orm";
import { blogPosts, events, vendors, venues } from "@/lib/db/schema";
import type { getCloudflareDb } from "@/lib/cloudflare";
import { EVENT_LISTING_SLUGS } from "@/lib/constants";
import type { Slug } from "@/lib/utils";

// Match /blog/<slug> occurrences (hrefs, markdown links, bare text).
const BLOG_LINK_RE = /\/blog\/([a-z0-9][a-z0-9-]*)(?=[^a-z0-9-]|$)/gi;

// Entity-aware content link extraction — see extractContentLinks below.
// `blog` is included so blog-to-blog internal links are captured by the
// same index that tracks event/vendor/venue references.
const CONTENT_LINK_RE = /\/(events|vendors|venues|blog)\/([a-z0-9][a-z0-9-]*)(?=[^a-z0-9-]|$)/gi;

export type ContentLinkTargetType = "EVENT" | "VENDOR" | "VENUE" | "BLOG_POST";

export interface ContentLinkRef {
  targetType: ContentLinkTargetType;
  targetSlug: string;
}

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
/**
 * Extract every /events/, /vendors/, /venues/ reference from a post body.
 * Deduplicates by (targetType, targetSlug). Filters out event listing routes
 * (e.g. /events/past, /events/maine) since those are routes, not event slugs.
 */
export function extractContentLinks(body: string | null | undefined): ContentLinkRef[] {
  if (!body) return [];
  const seen = new Set<string>();
  const out: ContentLinkRef[] = [];
  const re = new RegExp(CONTENT_LINK_RE.source, CONTENT_LINK_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const kind = m[1].toLowerCase();
    const slug = m[2].toLowerCase();
    if (!slug) continue;
    // Filter out event listing routes
    if (kind === "events" && EVENT_LISTING_SLUGS.has(slug)) continue;
    const targetType: ContentLinkTargetType =
      kind === "events"
        ? "EVENT"
        : kind === "vendors"
          ? "VENDOR"
          : kind === "venues"
            ? "VENUE"
            : "BLOG_POST";
    const key = `${targetType}|${slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ targetType, targetSlug: slug });
  }
  return out;
}

export async function findBrokenLinksInDb(
  db: ReturnType<typeof getCloudflareDb>,
  body: string
): Promise<string[]> {
  const referenced = extractBlogLinks(body);
  if (referenced.length === 0) return [];
  const rows = await db
    .select({ slug: blogPosts.slug })
    .from(blogPosts)
    .where(inArray(blogPosts.slug, referenced as Slug[]));
  const known = new Set(rows.map((r) => r.slug.toLowerCase()));
  return referenced.filter((s) => !known.has(s));
}

/**
 * DB-aware broken-link check across ALL four content-link target types
 * (EVENT, VENDOR, VENUE, BLOG_POST). Returns the refs that didn't resolve
 * to a live row — exactly the set of "broken" links per the analyst's
 * 2026-05-24 report on ~90 broken internal event links.
 *
 * Why a separate function from findBrokenLinksInDb: the latter only
 * checks /blog/<slug> refs and predates the BLOG_POST widening in PR
 * #222. This one mirrors the resolution logic in syncContentLinks but
 * is read-only — safe to call before a save to surface warnings.
 *
 * Returned shape matches the API warnings field. Empty array when
 * everything resolves cleanly.
 */
export async function findBrokenContentLinksInDb(
  db: ReturnType<typeof getCloudflareDb>,
  body: string
): Promise<ContentLinkRef[]> {
  const referenced = extractContentLinks(body);
  if (referenced.length === 0) return [];

  // Resolve in parallel — one query per target type, only for slugs of
  // that type that were actually referenced. Mirrors syncContentLinks.
  const resolvedKeys = new Set<string>();
  await Promise.all(
    (["EVENT", "VENDOR", "VENUE", "BLOG_POST"] as const).map(async (type) => {
      const slugs = referenced.filter((r) => r.targetType === type).map((r) => r.targetSlug);
      if (slugs.length === 0) return;
      const table =
        type === "EVENT"
          ? events
          : type === "VENDOR"
            ? vendors
            : type === "VENUE"
              ? venues
              : blogPosts;
      const rows = await db
        .select({ slug: table.slug })
        .from(table)
        .where(inArray(table.slug, slugs as Slug[]));
      for (const r of rows) {
        resolvedKeys.add(`${type}|${r.slug.toLowerCase()}`);
      }
    })
  );

  return referenced.filter((r) => !resolvedKeys.has(`${r.targetType}|${r.targetSlug}`));
}
