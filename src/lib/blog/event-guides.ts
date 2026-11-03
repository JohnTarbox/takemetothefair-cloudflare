/**
 * OPE-1188 — a fair's event page and series hub link that fair's own visitor
 * guide first, and blog posts link events at their canonical URL.
 *
 * Measured 2026-10-01: Fryeburg's guide WAS a direct link of its 2026 event,
 * but the related-posts block sorted direct links newest-first with a limit of
 * three, so September roundups that mention every fair (Topsfield, Salem)
 * pushed the April guide off the page. Durham's guide was not linked at all,
 * because it points at a legacy slug that content_links does not resolve to
 * the 2026 row. So the guide is found from what it IS — a post whose slug
 * starts with the fair's own name — rather than from link order.
 *
 * Blog bodies link events by whatever slug was current when written
 * (`/events/fryeburg-fair-2026`), each now a 301 hop. `resolveEventHrefs`
 * rewrites them at render to `canonicalEventPath`, the sitemap's own rule.
 */
import { and, eq, inArray, sql, desc } from "drizzle-orm";
import { createSlug, unsafeSlug, type Slug } from "@takemetothefair/utils";
import { stripNameEditionSuffix } from "@takemetothefair/event-series";
import { blogPosts, events, eventSeries, eventSlugHistory } from "@/lib/db/schema";
import type { getCloudflareDb } from "@/lib/cloudflare";
import { canonicalEventPath } from "@/lib/sitemap/indexable-events";
import { isPublicEventStatus } from "@/lib/event-status";

type Db = ReturnType<typeof getCloudflareDb>;

export interface VisitorGuide {
  title: string;
  slug: string;
  excerpt: string | null;
  publishDate: Date | null;
}

/**
 * The slug prefix a fair's own guide carries: the series name without its
 * parenthetical or edition, slugified. "The Big E (Eastern States Exposition)"
 * → "the-big-e"; "Fryeburg Fair" → "fryeburg-fair". Null when the name is too
 * generic to identify one fair (a single word, or under 8 characters), because
 * a prefix like "fair-" would claim every post about any fair.
 */
export function guideSlugPrefix(seriesName: string | null | undefined): string | null {
  if (!seriesName) return null;
  const core = stripNameEditionSuffix(seriesName.replace(/\s*\([^)]*\)\s*/g, " ").trim());
  const prefix: string = createSlug(core);
  if (prefix.length < 8 || prefix.split("-").length < 2) return null;
  return prefix;
}

/** Published posts written about this fair, guide-shaped slugs first, then newest. */
export async function getVisitorGuides(
  db: Db,
  seriesName: string | null | undefined,
  limit = 2
): Promise<VisitorGuide[]> {
  const prefix = guideSlugPrefix(seriesName);
  if (!prefix || limit <= 0) return [];
  const head = `${prefix}-`;
  try {
    return await db
      .select({
        title: blogPosts.title,
        slug: blogPosts.slug,
        excerpt: blogPosts.excerpt,
        publishDate: blogPosts.publishDate,
      })
      .from(blogPosts)
      .where(
        and(
          eq(blogPosts.status, "PUBLISHED"),
          // substr, not LIKE: D1 caps LIKE patterns at 50 chars.
          sql`substr(${blogPosts.slug}, 1, ${head.length}) = ${head}`
        )
      )
      // A guide-shaped slug first. Measured 2026-10-01: Fryeburg's is
      // "…everything-you-need-to-know-before-you-go", Durham's and Deerfield's
      // say "visitors-guide", the Big E's three all say "guide".
      .orderBy(
        sql`(instr(${blogPosts.slug}, 'guide') > 0 OR instr(${blogPosts.slug}, 'need-to-know') > 0 OR instr(${blogPosts.slug}, 'visitor') > 0) DESC`,
        desc(blogPosts.publishDate)
      )
      .limit(limit);
  } catch {
    return [];
  }
}

/** `/events/<slug>` hrefs in a markdown body, as bare slugs (deduped). */
export function extractEventSlugs(markdown: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const m of (markdown ?? "").matchAll(
    /\]\(\s*(?:https?:\/\/(?:www\.)?meetmeatthefair\.com)?\/events\/([a-z0-9-]+)\/?(?:[)#?\s])/gi
  )) {
    out.add(m[1].toLowerCase());
  }
  return [...out];
}

/** Normalise an href to the `/events/<slug>` key the resolver map uses. */
export function eventHrefKey(href: string | null | undefined): string | null {
  const m = (href ?? "").match(
    /^(?:https?:\/\/(?:www\.)?meetmeatthefair\.com)?(\/events\/[a-z0-9-]+)\/?(?:[#?].*)?$/i
  );
  return m ? m[1].toLowerCase() : null;
}

/**
 * `/events/<slug>` → the event's canonical path, for every slug whose canonical
 * differs (a series occurrence, or a renamed slug one history hop away). Slugs
 * that are already canonical, unknown, or non-public are left out, so the
 * renderer keeps the original href for them.
 */
export async function resolveEventHrefs(db: Db, slugs: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (slugs.length === 0) return map;
  try {
    const rename = new Map<string, string>(); // old slug → current slug
    const lookFor = new Set(slugs);
    for (let i = 0; i < slugs.length; i += 90) {
      const chunk = slugs.slice(i, i + 90).map((s) => unsafeSlug(s));
      const hist = await db
        .select({ oldSlug: eventSlugHistory.oldSlug, newSlug: eventSlugHistory.newSlug })
        .from(eventSlugHistory)
        .where(inArray(eventSlugHistory.oldSlug, chunk));
      for (const h of hist) {
        rename.set(h.oldSlug, h.newSlug);
        lookFor.add(h.newSlug);
      }
    }
    const targets = [...lookFor];
    const bySlug = new Map<string, string>();
    for (let i = 0; i < targets.length; i += 90) {
      const chunk = targets.slice(i, i + 90).map((s) => unsafeSlug(s));
      const rows = await db
        .select({
          slug: events.slug,
          startDate: events.startDate,
          seriesSlug: eventSeries.canonicalSlug,
          // OPE-1326 — canonicalEventPath needs the edition to build the URL.
          editionMode: eventSeries.editionMode,
          editionKey: events.editionKey,
        })
        .from(events)
        .leftJoin(eventSeries, eq(events.seriesId, eventSeries.id))
        .where(and(inArray(events.slug, chunk as Slug[]), isPublicEventStatus()));
      for (const r of rows) bySlug.set(r.slug, canonicalEventPath(r));
    }
    for (const s of slugs) {
      const canonical = bySlug.get(s) ?? (rename.has(s) ? bySlug.get(rename.get(s)!) : undefined);
      if (canonical && canonical !== `/events/${s}`) map.set(`/events/${s}`, canonical);
    }
  } catch {
    // Rewriting is an improvement, never a precondition: on failure the post
    // renders with its original hrefs, which still 301 to the right page.
  }
  return map;
}
