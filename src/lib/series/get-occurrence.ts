/**
 * EH3 P2.3b — resolve a (series canonical_slug, year) pair to the occurrence
 * event's own slug, so the `/events/[slug]/[year]` route can render it by
 * delegating to the event-detail page. React-cached (shared by the route's
 * generateMetadata + page). Returns null when the series or that year's
 * occurrence doesn't exist — every slug today, until the P1 backfill.
 */
import { cache } from "react";
import { eq, and } from "drizzle-orm";
import { parseOccurrenceSegment, resolveOccurrence, unsafeSlug } from "@takemetothefair/utils";
import { getCloudflareDb } from "@/lib/cloudflare";
import { withD1ReadLogged } from "@/lib/db/d1-resilience";
import { eventSeries, events } from "@/lib/db/schema";
import { isPublicEventStatus } from "@/lib/event-status";

/**
 * OPE-1326 — what `/events/<series>/<segment>` resolves to: render a member
 * (its own slug), or a 301 to the member's canonical occurrence path (a year URL
 * on a multi-edition series, or an edition URL on an annual one). The decision
 * is `resolveOccurrence`'s, shared with the middleware and the ETag lookup.
 */
export type OccurrenceTarget =
  | { slug: string; redirectTo?: undefined }
  | { slug: string; redirectTo: string };

export const resolveOccurrenceTarget = cache(
  async (seriesSlug: string, segmentStr: string): Promise<OccurrenceTarget | null> => {
    const segment = parseOccurrenceSegment(segmentStr);
    if (!segment) return null;
    // OPE-1301 — the series lookup failed on a D1 reset on 09-27
    // (cumberland-county-fair/2026, old-wethersfield…/2026) with no retry and
    // no degraded path. Retry-wrapped like the browse fetchers (OPE-790).
    return withD1ReadLogged("lib/series/get-occurrence.ts:resolveOccurrenceTarget", () =>
      resolveOnce(seriesSlug, segment)
    );
  }
);

/** The slug to render, or null for a redirect or a miss (callers that only render). */
export async function resolveOccurrenceSlug(
  seriesSlug: string,
  segmentStr: string
): Promise<string | null> {
  const t = await resolveOccurrenceTarget(seriesSlug, segmentStr);
  return t && !t.redirectTo ? t.slug : null;
}

async function resolveOnce(
  seriesSlug: string,
  segment: NonNullable<ReturnType<typeof parseOccurrenceSegment>>
): Promise<OccurrenceTarget | null> {
  const db = getCloudflareDb();
  const [series] = await db
    .select({ id: eventSeries.id, editionMode: eventSeries.editionMode })
    .from(eventSeries)
    .where(eq(eventSeries.canonicalSlug, unsafeSlug(seriesSlug)))
    .limit(1);
  if (!series) return null;

  // Few occurrences per series — match in JS rather than with a SQLite
  // strftime predicate.
  const occ = await db
    // `id` — OPE-1324: the shared picker tie-breaks on it, so the page and the
    // middleware's ETag lookup choose the same row even for two same-year members.
    .select({
      id: events.id,
      slug: events.slug,
      startDate: events.startDate,
      editionKey: events.editionKey,
    })
    .from(events)
    .where(and(eq(events.seriesId, series.id), isPublicEventStatus()));

  const r = resolveOccurrence(seriesSlug, series.editionMode, occ, segment);
  if (!r) return null;
  return r.action === "redirect"
    ? { slug: r.occurrence.slug, redirectTo: r.path }
    : { slug: r.occurrence.slug };
}
