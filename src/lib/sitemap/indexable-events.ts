/**
 * Indexable-event enumeration — the single source of truth for "which event
 * pages are eligible for the index, and what is each one's URL", shared by the
 * events sitemap and the GSC URL-inspection sweep (OPE-372, 2026-08-11).
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The sweep and the sitemap each built event URLs from their own query, and
 * they disagreed on three separate axes. 81 of the 318 open
 * `GSC_INSPECTION_NON_OK` rows — 25% — were the sweep asking Google about URLs
 * we deliberately do not publish, and then filing Google's correct answer as
 * our defect. Regenerated daily, so the queue refilled as fast as anyone drained
 * it.
 *
 *   1. URL SHAPE. The sitemap emits the canonical `/events/<series>/<year>` for
 *      a series occurrence; the sweep emitted the legacy flat `/events/<slug>`,
 *      i.e. `/events/augusta-boat-show-2026`. That flat URL 301s to the nested
 *      one — correctly — and the sweep logged 48 "Page with redirect" issues
 *      against our own working canonicalisation.
 *   2. COMPLETENESS. The sitemap requires `completeness_score >= 40`; the sweep
 *      had no threshold, so it inspected pages the sitemap withholds.
 *   3. START DATE. The sitemap requires a non-null `start_date`; the sweep did
 *      not.
 *
 * (The editorial/lifecycle gate did NOT diverge: the sitemap's
 * `isPublicEventStatus()` is literally a re-export of `publicEventWhere()`.
 * Worth stating, because "they use different function names" looks like a
 * fourth divergence and isn't.)
 *
 * The precedent for the fix was already in the sweep, one entity type over:
 * `indexable-vendors.ts` exists precisely so the sweep never inspects a vendor
 * page the sitemap withholds, "which would surface as false-positive noise."
 * Events simply never got the same treatment. This is that treatment.
 *
 * Same defect class as OPE-295 (two consumers of one dataset disagreeing
 * because neither reads the other's rule) and OPE-280 (blog `faqs` column vs
 * `body` headings). Third instance — the shape is now familiar enough to name:
 * when two surfaces must agree about a fact, the agreement has to live in one
 * function that both call, not in two implementations that currently match.
 */
import { and, eq, gte, isNotNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { events, eventSeries } from "@/lib/db/schema";
import { isPublicEventStatus } from "@/lib/event-status";
import { SITEMAP_MIN_COMPLETENESS } from "@/lib/completeness";

type Db = DrizzleD1Database<typeof schema>;

export interface IndexableEventRow {
  slug: string;
  /** Non-null when this event is an occurrence of a series (EH3 P2.4). */
  seriesSlug: string | null;
  updatedAt: Date | null;
  startDate: Date | null;
  endDate: Date | null;
}

/**
 * Every event whose detail page is index-eligible. This gate — and only this
 * gate — decides the population both the sitemap and the sweep operate on.
 */
export async function getIndexableEventRows(db: Db): Promise<IndexableEventRow[]> {
  return db
    .select({
      slug: events.slug,
      seriesSlug: eventSeries.canonicalSlug,
      updatedAt: events.updatedAt,
      startDate: events.startDate,
      endDate: events.endDate,
    })
    .from(events)
    .leftJoin(eventSeries, eq(events.seriesId, eventSeries.id))
    .where(
      and(
        isPublicEventStatus(),
        isNotNull(events.startDate),
        gte(events.completenessScore, SITEMAP_MIN_COMPLETENESS)
      )
    );
}

/**
 * The canonical path for one event's detail page.
 *
 * A series occurrence resolves to `/events/<series>/<year>`; a standalone event
 * keeps its own slug. This is the rule that was duplicated — anything needing
 * "what is this event's URL" must call here rather than interpolate a slug.
 */
export function canonicalEventPath(
  row: Pick<IndexableEventRow, "slug" | "seriesSlug" | "startDate">
): string {
  if (row.seriesSlug && row.startDate) {
    return `/events/${row.seriesSlug}/${new Date(row.startDate).getUTCFullYear()}`;
  }
  return `/events/${row.slug}`;
}

/** The series landing page path — one per series with ≥1 eligible occurrence. */
export function seriesLandingPath(seriesSlug: string): string {
  return `/events/${seriesSlug}`;
}

/**
 * Every published event path — occurrence/detail pages plus series landings.
 *
 * The sweep uses this as an allow-list: an `/events/` URL that is not in here
 * is one we do not advertise, so asking Google about it can only ever produce
 * noise. Returned as a Set because the sweep tests membership per URL.
 */
export function collectCanonicalEventPaths(rows: IndexableEventRow[]): Set<string> {
  const paths = new Set<string>();
  for (const row of rows) {
    paths.add(canonicalEventPath(row));
    if (row.seriesSlug) paths.add(seriesLandingPath(row.seriesSlug));
  }
  return paths;
}

/**
 * The same allow-list as absolute URLs. Convenience for the sweep, which
 * compares against fully-qualified URLs stored in `gsc_inspection_state`.
 */
export async function getCanonicalEventUrlSet(db: Db, host: string): Promise<Set<string>> {
  const rows = await getIndexableEventRows(db);
  return new Set([...collectCanonicalEventPaths(rows)].map((p) => `${host}${p}`));
}
