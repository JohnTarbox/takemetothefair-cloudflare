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
import { eventSeries, events } from "@/lib/db/schema";
import { isPublicEventStatus } from "@/lib/event-status";

export const resolveOccurrenceSlug = cache(
  async (seriesSlug: string, yearStr: string): Promise<string | null> => {
    const year = Number.parseInt(yearStr, 10);
    if (!Number.isInteger(year) || String(year) !== yearStr) return null;

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
      .select({ slug: events.slug, startDate: events.startDate })
      .from(events)
      .where(and(eq(events.seriesId, series.id), isPublicEventStatus()));

    const match = occ.find((o) => o.startDate && new Date(o.startDate).getUTCFullYear() === year);
    return match?.slug ?? null;
  }
);
