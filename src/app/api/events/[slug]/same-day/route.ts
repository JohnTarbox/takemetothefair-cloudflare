import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte, lte, ne, isNotNull, sql } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, promoters } from "@/lib/db/schema";
import { publicEventWhere } from "@/lib/event-lifecycle";
import { unsafeSlug } from "@/lib/utils";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export const runtime = "edge";

const MAX_RESULTS = 30;

/**
 * GET /api/events/[slug]/same-day
 *
 * Returns up to MAX_RESULTS publicly-visible events whose date range
 * overlaps the anchor event's [startDate, endDate], excluding the
 * anchor itself, ordered by |other.startDate - anchor.startDate|
 * (closest start dates first). Used by the "Other events on these
 * dates" widget on /events/[slug] — lazy-fired from a user button
 * click.
 *
 * Overlap formula: A.start <= B.end AND A.end >= B.start. Identical
 * to getVendorDateConflicts at src/app/events/[slug]/page.tsx:155,
 * but expressed in SQL so D1 does the filter.
 *
 * Known limitation: events with discontinuousDates=true (recurring/
 * multi-date markets) match on the outer envelope [startDate, endDate]
 * rather than the individual event_days rows. A weekly market that
 * runs May–October would over-match every event in that window.
 * Acceptable for the first cut; a follow-up could EXISTS-join
 * event_days for per-day matching.
 *
 * 404 when the slug doesn't resolve to a publicly-visible event, or
 * when the event has no startDate/endDate (no anchor to overlap with).
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const rateLimitResult = await checkRateLimit(request, "events-same-day");
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
  }

  const { slug } = await ctx.params;
  const db = getCloudflareDb();

  const [anchor] = await db
    .select({
      id: events.id,
      startDate: events.startDate,
      endDate: events.endDate,
    })
    .from(events)
    .where(and(eq(events.slug, unsafeSlug(slug)), publicEventWhere()))
    .limit(1);

  if (!anchor) {
    return NextResponse.json({ success: false, error: "not_found" }, { status: 404 });
  }
  if (!anchor.startDate || !anchor.endDate) {
    // Anchor exists but is undated (TBD) — overlap is undefined. Return
    // an empty success rather than 404 so the client can render a
    // helpful empty state instead of treating it like a missing slug.
    return NextResponse.json(
      { success: true, events: [] },
      { headers: { "Cache-Control": "public, max-age=300, s-maxage=300" } }
    );
  }

  // Drizzle's `mode: "timestamp"` stores seconds-epoch (the project's
  // convention since PR #58; see memory:
  // reference_drizzle_timestamp_mode_is_seconds). The stored column
  // is already integer seconds, so ORDER BY ABS(col - $sec) works
  // directly with no strftime conversion. Convert the anchor's
  // milliseconds-Date to seconds for unit parity.
  const anchorStartSec = Math.floor(anchor.startDate.getTime() / 1000);
  const rows = await db
    .select()
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .leftJoin(promoters, eq(events.promoterId, promoters.id))
    .where(
      and(
        publicEventWhere(),
        ne(events.id, anchor.id),
        isNotNull(events.startDate),
        isNotNull(events.endDate),
        lte(events.startDate, anchor.endDate),
        gte(events.endDate, anchor.startDate)
      )
    )
    .orderBy(sql`ABS(${events.startDate} - ${anchorStartSec}) ASC`)
    .limit(MAX_RESULTS);

  const eventsOut = rows.map((r) => ({
    ...r.events,
    venue: r.venues,
    promoter: r.promoters,
  }));

  return NextResponse.json(
    { success: true, events: eventsOut },
    { headers: { "Cache-Control": "public, max-age=300, s-maxage=300" } }
  );
}
