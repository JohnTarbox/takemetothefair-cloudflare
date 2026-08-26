/**
 * OPE-567 — when did the page behind an inspected URL last change?
 *
 * A GSC rich-result verdict describes the **last crawl**, not the page. To know
 * whether a FAIL is still true we need one fact the sweep did not previously
 * fetch: the entity row's `updated_at`. If the row changed after Google looked,
 * the verdict is about a version that no longer exists.
 *
 * ## Why a batched lookup is affordable here
 *
 * OPE-382 established that `run_site_health_sweep` already exceeds its time
 * budget, which made "one more query per URL" look like the wrong trade — and
 * that is why OPE-567 was filed listing a blunter age-based rule as a candidate.
 * Reading the loop settles it: the sweep makes **one GSC API call per URL** and
 * `batchSize` defaults to 8. A handful of D1 reads is nothing beside a handful
 * of network round-trips to Google. The budget is spent on the API.
 *
 * So this does the honest thing — compare against the page's own `updated_at` —
 * rather than the cheap thing. Age is a proxy that fails in the direction that
 * hides genuinely broken pages: a page nobody has touched since a three-week-old
 * crawl still has a valid FAIL.
 *
 * ## ⚠️ What this rule does NOT catch, stated plainly
 *
 * `updated_at` tracks the ROW, not the rendered page. A defect fixed purely in
 * code — a JSON-LD generator change, which is exactly what K46 and OPE-244 were
 * — moves no row, so a verdict about it is NOT detected as stale by this rule.
 *
 * That case still self-corrects: Google re-crawls, the verdict flips, and the
 * OPE-373/OPE-382 re-verify pass resolves the row. It is slower, and it is the
 * gap option 2 on the ticket would have closed by comparing against a deploy
 * date — rejected because it needs a constant somebody must remember to bump,
 * which is the failure mode this project keeps hitting.
 *
 * The four rows this shipped against happen to be caught anyway: their
 * `updated_at` moved (2026-06-29 / 2026-07-09) after the 2026-06-23 crawl for
 * unrelated reasons. Worth knowing that is luck, not the rule working as
 * designed on a code-only fix.
 */
import { inArray } from "drizzle-orm";
import { chunkedInArray, unsafeSlug } from "@takemetothefair/utils";
import { events, venues, vendors, promoters, blogPosts } from "@/lib/db/schema";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "@/lib/db/schema";

type Db = DrizzleD1Database<typeof schema>;

/** The five URL prefixes the site-health sweep inspects. */
const ENTITY_BY_SEGMENT = {
  events,
  venues,
  vendors,
  promoters,
  blog: blogPosts,
} as const;

type Segment = keyof typeof ENTITY_BY_SEGMENT;

export interface EntityRef {
  segment: Segment;
  slug: string;
}

/**
 * Pull `/{segment}/{slug}` out of an inspected URL.
 *
 * Returns null for anything else — the homepage, `/events` (the listing, not an
 * entity), a facet URL like `/events/me/september`, a deeper path. A null here
 * is not an error: the caller treats "no entity" as "cannot tell", which leaves
 * the verdict at ERROR. That is the safe direction.
 */
export function parseEntityRef(url: string): EntityRef | null {
  let path: string;
  try {
    path = url.startsWith("http") ? new URL(url).pathname : url;
  } catch {
    return null;
  }
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 2) return null; // exactly /<segment>/<slug>
  const [segment, slug] = parts;
  if (!(segment in ENTITY_BY_SEGMENT)) return null;
  if (!slug) return null;
  return { segment: segment as Segment, slug: decodeURIComponent(slug) };
}

/**
 * Map each inspected URL to the `updated_at` of the row behind it.
 *
 * URLs that do not resolve to an entity are simply absent from the map, so a
 * caller doing `map.get(url)` gets `undefined` and treats the verdict as
 * current. One query per segment present in the batch — at most five — each
 * chunked through `chunkedInArray` so the IN list can never trip D1's
 * 100-bound-parameter cap however large a future `batchSize` becomes.
 */
export async function buildPageLastChangedMap(
  db: Db,
  urls: readonly string[]
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();

  // slug → the URLs that resolve to it, per segment. A slug can legitimately
  // appear under more than one URL form, so this is a list, not a single value.
  const bySegment = new Map<Segment, Map<string, string[]>>();
  for (const url of urls) {
    const ref = parseEntityRef(url);
    if (!ref) continue;
    let slugs = bySegment.get(ref.segment);
    if (!slugs) bySegment.set(ref.segment, (slugs = new Map()));
    const existing = slugs.get(ref.slug);
    if (existing) existing.push(url);
    else slugs.set(ref.slug, [url]);
  }

  for (const [segment, slugMap] of bySegment) {
    const slugs = [...slugMap.keys()];
    // Selected explicitly per segment rather than through a table union:
    // Drizzle cannot infer a row shape across five different tables, and
    // casting it away would silently hide a column rename behind `unknown`.
    const rows: Array<{ slug: string; updatedAt: Date | null }> = await chunkedInArray(
      slugs,
      (batch) => selectSlugAndUpdatedAt(db, segment, batch)
    );
    for (const row of rows) {
      if (!row.updatedAt) continue;
      for (const url of slugMap.get(row.slug) ?? []) out.set(url, row.updatedAt);
    }
  }

  return out;
}

/** One typed SELECT per segment. Verbose on purpose — see the note at the call site. */
function selectSlugAndUpdatedAt(
  db: Db,
  segment: Segment,
  slugs: string[]
): Promise<Array<{ slug: string; updatedAt: Date | null }>> {
  switch (segment) {
    case "events":
      return db
        .select({ slug: events.slug, updatedAt: events.updatedAt })
        .from(events)
        .where(inArray(events.slug, slugs.map(unsafeSlug)));
    case "venues":
      return db
        .select({ slug: venues.slug, updatedAt: venues.updatedAt })
        .from(venues)
        .where(inArray(venues.slug, slugs.map(unsafeSlug)));
    case "vendors":
      return db
        .select({ slug: vendors.slug, updatedAt: vendors.updatedAt })
        .from(vendors)
        .where(inArray(vendors.slug, slugs.map(unsafeSlug)));
    case "promoters":
      return db
        .select({ slug: promoters.slug, updatedAt: promoters.updatedAt })
        .from(promoters)
        .where(inArray(promoters.slug, slugs.map(unsafeSlug)));
    case "blog":
      return db
        .select({ slug: blogPosts.slug, updatedAt: blogPosts.updatedAt })
        .from(blogPosts)
        .where(inArray(blogPosts.slug, slugs.map(unsafeSlug)));
  }
}
