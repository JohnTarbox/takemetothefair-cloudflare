export const dynamic = "force-dynamic";
/**
 * EH3 P3.1 — create_occurrence: create a new dated occurrence under a series,
 * NEVER mutating a past one. The main-app side (it owns src/lib + the DB); the
 * `create_occurrence` MCP tool is a thin X-Internal-Key wrapper, and the K27
 * rollover (P3.5) calls this same route.
 *
 * Locked decisions (John 2026-06-21): skeleton posture — TENTATIVE,
 * dates_confirmed=false, flagged_for_review, dates only from explicit overrides
 * (no RRULE compute). Year-bucketed idempotency. Inherits venue/promoter/etc.
 * from the event_series row.
 *
 * Dual auth: admin session OR X-Internal-Key. Insert mirrors suggest_event;
 * field inheritance is the unit-tested inheritSeriesDefaults.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { internalKeyMatches } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, eventSeries, adminActions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createSlug, appendSlugSegment, unsafeSlug } from "@takemetothefair/utils";
import {
  inheritSeriesDefaults,
  type SeriesRow,
  type OccurrenceOverrides,
} from "@/lib/series/create-occurrence-core";
import { logError } from "@/lib/logger";

async function authorize(request: NextRequest): Promise<boolean> {
  if (await internalKeyMatches(request)) return true;
  const session = await auth();
  return session?.user?.role === "ADMIN";
}

/** Year of an existing series sibling — from its start date, else a -YYYY slug suffix. */
function siblingYear(startDate: Date | null, slug: string): number | null {
  if (startDate) return new Date(startDate).getUTCFullYear();
  const m = slug.match(/-(\d{4})$/);
  return m ? Number.parseInt(m[1], 10) : null;
}

function parseDate(s: unknown): Date | null {
  if (typeof s !== "string" || !s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function POST(request: NextRequest) {
  try {
    if (!(await authorize(request))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      series_id?: string;
      year?: number;
      name?: string;
      venue_id?: string | null;
      promoter_id?: string | null;
      start_date?: string;
      end_date?: string;
      description?: string | null;
      image_url?: string | null;
      rolled_from_event_id?: string | null;
    };

    if (!body.series_id || !Number.isInteger(body.year)) {
      return NextResponse.json(
        { error: "series_id and an integer year are required." },
        { status: 400 }
      );
    }
    const year = body.year as number;
    const db = getCloudflareDb();

    const [series] = await db
      .select({
        id: eventSeries.id,
        name: eventSeries.name,
        venueId: eventSeries.venueId,
        promoterId: eventSeries.promoterId,
        recurrenceRule: eventSeries.recurrenceRule,
        description: eventSeries.description,
        imageUrl: eventSeries.imageUrl,
        categories: eventSeries.categories,
        tags: eventSeries.tags,
        primaryAudience: eventSeries.primaryAudience,
        publicAccess: eventSeries.publicAccess,
      })
      .from(eventSeries)
      .where(eq(eventSeries.id, body.series_id))
      .limit(1);

    if (!series) {
      return NextResponse.json({ error: "series_not_found" }, { status: 404 });
    }

    // Year-bucketed idempotency: refuse if this series already has `year`.
    const siblings = await db
      .select({ id: events.id, slug: events.slug, startDate: events.startDate })
      .from(events)
      .where(eq(events.seriesId, body.series_id));
    const clash = siblings.find((s) => siblingYear(s.startDate ?? null, s.slug) === year);
    if (clash) {
      return NextResponse.json(
        { created: false, reason: "occurrence_exists", existing_event_id: clash.id, year },
        { status: 200 }
      );
    }

    const overrides: OccurrenceOverrides = {
      name: body.name,
      venueId: body.venue_id,
      promoterId: body.promoter_id,
      startDate: parseDate(body.start_date),
      endDate: parseDate(body.end_date),
      description: body.description,
      imageUrl: body.image_url,
    };
    const values = inheritSeriesDefaults(series as SeriesRow, overrides, {
      rolledFromEventId: body.rolled_from_event_id ?? null,
    });

    // events.promoter_id is NOT NULL — a series with no default promoter needs one supplied.
    if (!values.promoterId) {
      return NextResponse.json(
        { error: "promoter_required: series has no default promoter; pass promoter_id." },
        { status: 400 }
      );
    }

    // Year-suffixed slug, uniqueness-resolved (mirrors suggest_event).
    const baseSlug = createSlug(`${values.name} ${year}`);
    let finalSlug = baseSlug;
    let suffix = 0;
    while (true) {
      const candidate = suffix > 0 ? appendSlugSegment(baseSlug, suffix) : baseSlug;
      const existing = await db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.slug, unsafeSlug(candidate)))
        .limit(1);
      if (existing.length === 0) {
        finalSlug = candidate;
        break;
      }
      suffix++;
    }

    const eventId = crypto.randomUUID();
    const now = new Date();
    await db.insert(events).values({
      id: eventId,
      seriesId: values.seriesId,
      name: values.name,
      slug: finalSlug,
      description: values.description,
      promoterId: values.promoterId,
      venueId: values.venueId,
      startDate: values.startDate,
      endDate: values.endDate,
      datesConfirmed: values.datesConfirmed,
      recurrenceRule: values.recurrenceRule,
      categories: values.categories ?? "[]",
      tags: values.tags ?? "[]",
      imageUrl: values.imageUrl,
      primaryAudience: values.primaryAudience,
      publicAccess: values.publicAccess,
      status: values.status,
      lifecycleStatus: values.lifecycleStatus,
      // flagged_for_review is a plain INTEGER column (not boolean-mode).
      flaggedForReview: values.flaggedForReview ? 1 : 0,
      rolledFromEventId: values.rolledFromEventId,
      sourceName: "series-occurrence",
      ingestionMethod: "admin_manual",
      syncEnabled: false,
      createdAt: now,
      updatedAt: now,
    });

    const session = await auth();
    await db.insert(adminActions).values({
      action: "event.occurrence_created",
      actorUserId: session?.user?.id ?? null,
      targetType: "event",
      targetId: eventId,
      payloadJson: JSON.stringify({
        series_id: values.seriesId,
        year,
        slug: finalSlug,
        rolled_from_event_id: values.rolledFromEventId,
      }),
      createdAt: now,
    });

    return NextResponse.json({ created: true, occurrence_id: eventId, slug: finalSlug, year });
  } catch (e) {
    const db = getCloudflareDb();
    await logError(db, {
      message: "create_occurrence failed",
      error: e,
      source: "app/api/admin/occurrences/create/route.ts:POST",
    });
    return NextResponse.json({ error: "create_occurrence failed" }, { status: 500 });
  }
}
