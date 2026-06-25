import { and, gte, inArray, lt } from "drizzle-orm";
import { blogPosts, events, eventSlugHistory, vendors, venues } from "@/lib/db/schema";
import type { getCloudflareDb } from "@/lib/cloudflare";
import { EVENT_LISTING_SLUGS } from "@/lib/constants";
import { getSlugPrefixBounds, type Slug } from "@/lib/utils";

/**
 * D1 caps each statement at 100 bound parameters. Every `inArray(col, slugs)`
 * resolution here can exceed that on link-dense posts — the CT pillar
 * (`connecticut-fairs-and-festivals-2026-...`) references 100+ events in one
 * body, which blew past the cap as "too many SQL variables at offset 360"
 * (K42). Chunk every `IN (...)` lookup at 90 to leave headroom for the
 * non-list columns in the statement. Same bound-param family as MIG6 / the
 * event_days chunking (PR #200).
 */
export const CONTENT_LINK_INARRAY_CHUNK = 90;

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
  const resolved = await resolveContentLinkTargetIds(db, referenced);
  return referenced.filter((r) => !resolved.has(`${r.targetType}|${r.targetSlug}`));
}

function contentLinkKey(targetType: ContentLinkTargetType, slug: string): string {
  return `${targetType}|${slug.toLowerCase()}`;
}

/**
 * Resolve a set of content-link refs to their live target ids.
 *
 * Returns a map keyed `TYPE|slug` → target id, containing only refs that
 * resolve. A ref absent from the map is "broken" (no live entity, no
 * redirect). Two-pass resolution:
 *
 *  1. **Current slug** — `events.slug` / `vendors.slug` / `venues.slug` /
 *     `blog_posts.slug`. Chunked at {@link CONTENT_LINK_INARRAY_CHUNK} to
 *     stay under D1's 100 bound-param cap (K42).
 *  2. **`event_slug_history` redirects (EVENT only)** — any EVENT ref that
 *     didn't resolve via the current slug is re-checked against
 *     `event_slug_history.old_slug`. A body link to an event that has since
 *     been renamed (admin edit, merge, or EH3 series-occurrence
 *     canonicalization) 301-redirects to its current URL via middleware, so
 *     it is NOT broken — it resolves to the event's id. This is the K45
 *     re-resolution fix and what keeps EH3-canonicalized links off the
 *     broken-link surface (K43 acceptance #3).
 *
 * Read-only; safe to call before a save (publish gate) and during sync.
 */
export async function resolveContentLinkTargetIds(
  db: ReturnType<typeof getCloudflareDb>,
  refs: ContentLinkRef[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (refs.length === 0) return map;

  // Pass 1 — current slugs, one chunked lookup per target type.
  await Promise.all(
    (["EVENT", "VENDOR", "VENUE", "BLOG_POST"] as const).map(async (type) => {
      const slugs = refs.filter((r) => r.targetType === type).map((r) => r.targetSlug);
      if (slugs.length === 0) return;
      const table =
        type === "EVENT"
          ? events
          : type === "VENDOR"
            ? vendors
            : type === "VENUE"
              ? venues
              : blogPosts;
      for (let i = 0; i < slugs.length; i += CONTENT_LINK_INARRAY_CHUNK) {
        const chunk = slugs.slice(i, i + CONTENT_LINK_INARRAY_CHUNK);
        const rows = await db
          .select({ id: table.id, slug: table.slug })
          .from(table)
          .where(inArray(table.slug, chunk as Slug[]));
        for (const r of rows) map.set(contentLinkKey(type, r.slug), r.id);
      }
    })
  );

  // Pass 2 — EVENT redirects via event_slug_history for refs still unresolved.
  const unresolvedEventSlugs = refs
    .filter((r) => r.targetType === "EVENT" && !map.has(contentLinkKey("EVENT", r.targetSlug)))
    .map((r) => r.targetSlug);
  if (unresolvedEventSlugs.length > 0) {
    for (let i = 0; i < unresolvedEventSlugs.length; i += CONTENT_LINK_INARRAY_CHUNK) {
      const chunk = unresolvedEventSlugs.slice(i, i + CONTENT_LINK_INARRAY_CHUNK);
      const rows = await db
        .select({ eventId: eventSlugHistory.eventId, oldSlug: eventSlugHistory.oldSlug })
        .from(eventSlugHistory)
        .where(inArray(eventSlugHistory.oldSlug, chunk as Slug[]));
      for (const r of rows) {
        const key = contentLinkKey("EVENT", r.oldSlug);
        if (!map.has(key)) map.set(key, r.eventId);
      }
    }
  }

  return map;
}

/**
 * Best-effort canonical-slug suggestions for a broken content link, for the
 * publish-time gate's "did you mean…" hint (K43 acceptance #1). Strips a
 * trailing year / ordinal off the broken slug, prefix-scans live slugs of the
 * same target type, and returns up to 3 candidates ordered by shared-prefix
 * length. Cheap (indexed prefix range) and silent on failure — a suggestion
 * is a courtesy, never load-bearing.
 */
export async function suggestCanonicalSlugs(
  db: ReturnType<typeof getCloudflareDb>,
  ref: ContentLinkRef
): Promise<string[]> {
  const table =
    ref.targetType === "EVENT"
      ? events
      : ref.targetType === "VENDOR"
        ? vendors
        : ref.targetType === "VENUE"
          ? venues
          : blogPosts;
  // Drop a trailing `-2026` year and/or leading ordinal noise, then keep the
  // first ~3 hyphen tokens as a prefix probe.
  const stripped = ref.targetSlug.replace(/-(19|20)\d{2}$/, "");
  const prefix = stripped.split("-").slice(0, 3).join("-");
  if (prefix.length < 3) return [];
  const [lowerBound, upperBound] = getSlugPrefixBounds(prefix);
  try {
    const rows = await db
      .select({ slug: table.slug })
      .from(table)
      .where(and(gte(table.slug, lowerBound as Slug), lt(table.slug, upperBound as Slug)))
      .limit(8);
    const sharedLen = (a: string, b: string) => {
      let n = 0;
      while (n < a.length && n < b.length && a[n] === b[n]) n++;
      return n;
    };
    return rows
      .map((r) => r.slug as string)
      .filter((s) => s !== ref.targetSlug)
      .sort((a, b) => sharedLen(b, ref.targetSlug) - sharedLen(a, ref.targetSlug))
      .slice(0, 3);
  } catch {
    return [];
  }
}
