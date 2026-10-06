/**
 * EH3 P2.3b — resolve a (series canonical_slug, year) pair to the occurrence
 * event's own slug, so the `/events/[slug]/[year]` route can render it by
 * delegating to the event-detail page. React-cached (shared by the route's
 * generateMetadata + page). Returns null when the series or that year's
 * occurrence doesn't exist — every slug today, until the P1 backfill.
 */
import { cache } from "react";
import { eq, and } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { getCloudflareDb } from "@/lib/cloudflare";
import { withD1ReadLogged } from "@/lib/db/d1-resilience";
import { eventSeries, events } from "@/lib/db/schema";
import { isPublicEventStatus } from "@/lib/event-status";
import { parseOccurrenceYear, pickOccurrenceForYear } from "./occurrence-year";

export const resolveOccurrenceSlug = cache(
  async (seriesSlug: string, yearStr: string): Promise<string | null> => {
    const year = parseOccurrenceYear(yearStr);
    if (year === null) return null;
    // OPE-1301 — the series lookup failed on a D1 reset on 09-27
    // (cumberland-county-fair/2026, old-wethersfield…/2026) with no retry and
    // no degraded path. Retry-wrapped like the browse fetchers (OPE-790).
    return withD1ReadLogged("lib/series/get-occurrence.ts:resolveOccurrenceSlug", () =>
      resolveOnce(seriesSlug, year)
    );
  }
);

async function resolveOnce(seriesSlug: string, year: number): Promise<string | null> {
  const db = getCloudflareDb();
  const [series] = await db
    .select({ id: eventSeries.id })
    .from(eventSeries)
    .where(eq(eventSeries.canonicalSlug, unsafeSlug(seriesSlug)))
    .limit(1);
  if (!series) return null;

  // Few occurrences per series — match the start-year in JS rather than with
  // a SQLite strftime predicate.
  const occ = await db
    // `id` — OPE-1324: the shared picker tie-breaks on it, so the page and the
    // middleware's ETag lookup choose the same row even for two same-year members.
    .select({ id: events.id, slug: events.slug, startDate: events.startDate })
    .from(events)
    .where(and(eq(events.seriesId, series.id), isPublicEventStatus()));

  return pickOccurrenceForYear(occ, year)?.slug ?? null;
}
