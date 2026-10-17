export const dynamic = "force-dynamic";
/**
 * OPE-1480 — one-off (and re-runnable) backfill of Google's accessibility +
 * parking onto venues that already have a `google_place_id`.
 *
 * Bulk-mutation discipline (docs/bulk-mutation-discipline.md):
 *  - single writer: this route, paged by `limit` (≤ 50) and a stable id order;
 *  - idempotent: a venue is a candidate only while a column is NULL (or "{}"
 *    with `refetch_empty`), so a re-run after success does nothing;
 *  - never blanks: `amenityFillUpdates` refuses to replace Google data with an
 *    empty answer;
 *  - rollback: every write records before/after in admin_actions
 *    (`google-amenities:fill`), so a column can be restored row by row.
 *
 * `dry_run` defaults to TRUE: it reports the candidate count (= Places calls a
 * real run would make) and makes no Google call at all.
 */
import { NextResponse } from "next/server";
import { and, asc, gt, isNotNull, isNull, or, eq } from "drizzle-orm";
import { withInternalKey } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { venues } from "@/lib/db/schema";
import { fillVenueGoogleAmenities, type AmenityFillResult } from "@/lib/venues/google-amenity-fill";

const MAX_PER_CALL = 50;

interface Body {
  dry_run?: boolean;
  limit?: number;
  /** Resume after this venue id (the previous page's `next_after`). */
  after?: string;
  /** Also re-ask Google for columns holding "{}". */
  refetch_empty?: boolean;
}

export const POST = withInternalKey(
  { source: "api/admin/venues/google-amenities-backfill" },
  async ({ request, db }) => {
    const body = (await request.json().catch(() => ({}))) as Body;
    const dryRun = body.dry_run !== false;
    const limit = Math.max(1, Math.min(body.limit ?? MAX_PER_CALL, MAX_PER_CALL));
    const apiKey = getCloudflareEnv().GOOGLE_MAPS_API_KEY;
    if (!dryRun && !apiKey) {
      return NextResponse.json(
        { error: "Google Maps API key is not configured." },
        { status: 500 }
      );
    }

    const needs = body.refetch_empty
      ? or(
          isNull(venues.accessibility),
          isNull(venues.parking),
          eq(venues.accessibility, ""),
          eq(venues.parking, ""),
          eq(venues.accessibility, "{}"),
          eq(venues.parking, "{}")
        )
      : or(
          isNull(venues.accessibility),
          isNull(venues.parking),
          eq(venues.accessibility, ""),
          eq(venues.parking, "")
        );
    const where = and(
      isNotNull(venues.googlePlaceId),
      needs,
      body.after ? gt(venues.id, body.after) : undefined
    );

    const total = await db.$count(venues, and(isNotNull(venues.googlePlaceId), needs));

    const page = await db
      .select({ id: venues.id })
      .from(venues)
      .where(where)
      .orderBy(asc(venues.id))
      .limit(limit);

    const counts: Record<AmenityFillResult["status"], number> = {
      filled: 0,
      unchanged: 0,
      "no-place-id": 0,
      "fetch-failed": 0,
      "not-needed": 0,
    };
    if (!dryRun) {
      for (const { id } of page) {
        const r = await fillVenueGoogleAmenities(db, id, apiKey as string, {
          actor: "google-amenities-backfill",
          refetchEmpty: body.refetch_empty === true,
        });
        counts[r.status]++;
      }
    }

    return NextResponse.json({
      dry_run: dryRun,
      candidates_total: total,
      page_size: page.length,
      places_calls_this_page: dryRun
        ? 0
        : page.length - counts["not-needed"] - counts["no-place-id"],
      counts: dryRun ? null : counts,
      next_after: page.length === limit ? page[page.length - 1].id : null,
    });
  }
);
