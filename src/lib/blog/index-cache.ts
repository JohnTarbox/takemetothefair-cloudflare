/**
 * OPE-1573 — the public /blog index served from ONE cached copy of the
 * published-post set, filtered / paginated / tag-ranked in memory.
 *
 * On 2026-11-11 09:21–09:39Z a residential-proxy crawler walked `/blog?tag=…`
 * (558 hits, 365 distinct URLs) alongside `/vendors?type=…` (978 distinct of
 * 1,000 sampled hits) and drove D1 into "overloaded" at 09:34:48Z. Each
 * force-dynamic /blog render ran three reads that scan every blog post:
 *   1. the page select — `instr(lower(tags), ?)` cannot use an index, and the
 *      row carries `body` (only needed for the first-image fallback);
 *   2. the matching `count(*)`;
 *   3. `SELECT tags FROM blog_posts WHERE status='PUBLISHED'` for the sidebar.
 * D1 GraphQL, 09:34:35–09:34:50Z: 620 calls of (1) and 246 of (3).
 *
 * The crawl's cost is per DISTINCT URL, so a cache keyed on `?tag=` would not
 * help (see the /vendors note in src/lib/vendors/listing-cache.ts). The whole
 * published set is small (~155 rows), so it is cached once and every public
 * render — any tag, any page — is served from it. Admin renders (which include
 * drafts) stay live.
 */
export const BLOG_INDEX_CACHE_TTL_SECONDS = 300; // matches the page's `revalidate`

/** Bump the `:vN` suffix when the cached value's SHAPE changes. */
export const BLOG_INDEX_CACHE_KEY = "cache:blog:index:v1";

/** One published post as cached: JSON-safe, `body` already reduced to its first image. */
export interface CachedBlogIndexPost {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  authorName: string | null;
  /** Raw JSON string as stored, so the tag filter can apply the SQL predicate verbatim. */
  tags: string | null;
  categories: string | null;
  /** `featured_image_url`, or the first image in the body when that is empty. */
  featuredImageUrl: string | null;
  status: string;
  /** ISO string (a Date does not survive the JSON round-trip through KV). */
  publishDate: string | null;
}

/**
 * SQLite's `lower()` folds ASCII only, and `containsCI` applies it to the
 * COLUMN while lower-casing the NEEDLE in JS (`needle.toLowerCase()`, full
 * Unicode). Mirroring that asymmetry exactly keeps this filter identical to
 * the SQL it replaced: e.g. `?tag=FÊTE` matches a stored `Fête` (column folds
 * to `fête`, needle to `fête`), but `?tag=fête` does NOT match a stored `FÊTE`.
 */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * The same predicate the SQL path used: `containsCI(blogPosts.tags, '"<tag>"')`
 * after stripping `"` and `\` from the tag. A NULL `tags` never matches
 * (`instr(NULL, …)` is NULL).
 */
export function blogPostMatchesTag(post: Pick<CachedBlogIndexPost, "tags">, tag: string): boolean {
  if (post.tags === null) return false;
  const needle = `"${tag.replace(/["\\]/g, "")}"`;
  return asciiLower(post.tags).includes(needle.toLowerCase());
}

/**
 * Page `page` (1-based) of the posts matching `tag`, from a set already in
 * `publish_date DESC` order — the order the loader's query returns.
 */
export function selectBlogIndexPage(
  all: CachedBlogIndexPost[],
  opts: { tag?: string; page: number; perPage: number }
): { posts: CachedBlogIndexPost[]; total: number } {
  const matching = opts.tag ? all.filter((p) => blogPostMatchesTag(p, opts.tag!)) : all;
  const offset = (opts.page - 1) * opts.perPage;
  return { posts: matching.slice(offset, offset + opts.perPage), total: matching.length };
}
