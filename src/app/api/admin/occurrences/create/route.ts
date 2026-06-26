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
import { createOccurrenceForSeries } from "@/lib/series/create-occurrence";
import { logError } from "@/lib/logger";

async function authorize(request: NextRequest): Promise<boolean> {
  if (await internalKeyMatches(request)) return true;
  const session = await auth();
  return session?.user?.role === "ADMIN";
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
    const session = await auth();

    const result = await createOccurrenceForSeries(db, {
      seriesId: body.series_id,
      year,
      overrides: {
        name: body.name,
        venueId: body.venue_id,
        promoterId: body.promoter_id,
        startDate: parseDate(body.start_date),
        endDate: parseDate(body.end_date),
        description: body.description,
        imageUrl: body.image_url,
      },
      rolledFromEventId: body.rolled_from_event_id ?? null,
      actorUserId: session?.user?.id ?? null,
    });

    if (!result.created) {
      if (result.reason === "series_not_found") {
        return NextResponse.json({ error: "series_not_found" }, { status: 404 });
      }
      if (result.reason === "occurrence_exists") {
        return NextResponse.json(
          {
            created: false,
            reason: "occurrence_exists",
            existing_event_id: result.existingEventId,
            year,
          },
          { status: 200 }
        );
      }
      // promoter_required
      return NextResponse.json(
        { error: "promoter_required: series has no default promoter; pass promoter_id." },
        { status: 400 }
      );
    }

    return NextResponse.json({
      created: true,
      occurrence_id: result.occurrenceId,
      slug: result.slug,
      year: result.year,
    });
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
