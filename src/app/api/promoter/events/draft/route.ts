export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { detectPossibleDuplicate } from "@/lib/duplicates/venue-date-collision";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { requireVerifiedSession } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { promoters, events, eventDays } from "@/lib/db/schema";
import { createSlug, computePublicDates, dollarsToCents } from "@/lib/utils";
import { resolveUniqueEventSlug, insertEventDaysBatched } from "@/lib/events/insert-helpers";
import { recordMutation } from "@/lib/audit/record-mutation";
import { validateRequestBody, promoterEventCreateSchema } from "@/lib/validations";
import { logError } from "@/lib/logger";
import { normalizeEventDate } from "@/lib/event-dates";
import { recomputeEventCompleteness } from "@/lib/completeness";

interface EventDayInput {
  date: string;
  openTime: string;
  closeTime: string;
  notes?: string | null;
  closed?: boolean;
  vendorOnly?: boolean;
}

/**
 * Draft-save / submit endpoint for the promoter event wizard.
 *
 * Body is the same shape as POST /api/promoter/events, plus:
 *   - id?: existing event id to update (must belong to the signed-in promoter
 *          AND currently be in DRAFT status)
 *   - submit?: when true, transitions DRAFT → PENDING
 *
 * Without id: creates a new DRAFT event.
 * With id: updates the existing DRAFT (and optionally submits).
 * Returns { id, slug, status }.
 */
export async function POST(request: NextRequest) {
  const db = getCloudflareDb();
  // OPE-703 — a verified email before publishing to a public directory.
  //
  // Approved by John 2026-08-31 on a measured recommendation: this route's
  // ONLY callers are the promoter's own browser UI (src/app/promoter/events/
  // new/page.tsx), ingestion creates events through direct inserts and never
  // touches it, and all 6 real registered promoters were already verified when
  // this shipped. So it closes the last ungated owner-facing write at a cost of
  // zero affected accounts — the 717 "unverified" promoter owners are
  // `pending+…` ingestion placeholders that hold no session.
  const gate = await requireVerifiedSession();
  if (!gate.ok) return gate.response;
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const promoterResults = await db
      .select()
      .from(promoters)
      .where(eq(promoters.userId, session.user.id))
      .limit(1);

    if (promoterResults.length === 0) {
      return NextResponse.json(
        { error: "Promoter profile not found. Please complete your profile first." },
        { status: 404 }
      );
    }
    const promoter = promoterResults[0];

    // Parse raw body to pick up id/submit before validation trims them.
    const raw = (await request
      .clone()
      .json()
      .catch(() => ({}))) as {
      id?: string;
      submit?: boolean;
    };
    const existingId = typeof raw.id === "string" ? raw.id : undefined;
    const submit = raw.submit === true;

    const validation = await validateRequestBody(request, promoterEventCreateSchema);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const data = validation.data;

    const isDiscontinuous = !!data.discontinuousDates;
    const eventDaysInput = (data.eventDays ?? []) as EventDayInput[];

    // Compute overall start/end from eventDays if discontinuous
    let startDate = data.startDate ?? null;
    let endDate = data.endDate ?? null;
    if (isDiscontinuous && eventDaysInput.length > 0) {
      const sorted = eventDaysInput.map((d) => d.date).sort();
      // OPE-482: normalizeEventDate (noon UTC), NOT parseDateOnly (midnight
      // UTC). Midnight-UTC is 8pm Eastern the previous day, so those rows
      // render one day early. Same fix the PUT handler's discontinuous branch
      // already carries — this create path was the one it missed.
      startDate = normalizeEventDate(sorted[0])?.toISOString() ?? null;
      endDate = normalizeEventDate(sorted[sorted.length - 1])?.toISOString() ?? null;
    }

    // Public date range (excludes vendor-only days)
    const { publicStartDate, publicEndDate } =
      eventDaysInput.length > 0
        ? computePublicDates(eventDaysInput)
        : {
            // OPE-543 — NULL, not a copy of start/end. Nothing invalidates such a
            // copy on a later date edit, and every reader falls back to start/end.
            publicStartDate: null,
            publicEndDate: null,
          };

    const finalStatus = submit ? "PENDING" : "DRAFT";

    // ─── Update existing draft ─────────────────────────────────────────
    if (existingId) {
      const [existing] = await db
        .select()
        .from(events)
        .where(and(eq(events.id, existingId), eq(events.promoterId, promoter.id)))
        .limit(1);
      if (!existing) {
        return NextResponse.json({ error: "Draft not found" }, { status: 404 });
      }
      if (existing.status !== "DRAFT") {
        return NextResponse.json(
          { error: "Only DRAFT events can be updated through this endpoint." },
          { status: 400 }
        );
      }

      await db
        .update(events)
        .set({
          name: data.name,
          description: data.description,
          venueId: data.venueId || null,
          stateCode: data.stateCode || null,
          isStatewide: data.isStatewide ?? false,
          // OPE-482: `new Date("YYYY-MM-DD")` is midnight UTC = 8pm Eastern the
          // previous day. normalizeEventDate anchors at noon UTC.
          startDate: normalizeEventDate(startDate),
          endDate: normalizeEventDate(endDate),
          publicStartDate,
          publicEndDate,
          discontinuousDates: isDiscontinuous,
          categories: JSON.stringify(data.categories ?? []),
          tags: JSON.stringify(data.tags ?? []),
          ticketUrl: data.ticketUrl,
          ticketPriceMinCents: dollarsToCents(data.ticketPriceMin),
          ticketPriceMaxCents: dollarsToCents(data.ticketPriceMax),
          imageUrl: data.imageUrl,
          vendorFeeMinCents: dollarsToCents(data.vendorFeeMin),
          vendorFeeMaxCents: dollarsToCents(data.vendorFeeMax),
          vendorFeeNotes: data.vendorFeeNotes,
          indoorOutdoor: data.indoorOutdoor,
          estimatedAttendance: data.estimatedAttendance,
          eventScale: data.eventScale,
          applicationDeadline: data.applicationDeadline ? new Date(data.applicationDeadline) : null,
          applicationUrl: data.applicationUrl,
          applicationInstructions: data.applicationInstructions,
          walkInsAllowed: data.walkInsAllowed,
          status: finalStatus,
          updatedAt: new Date(),
        })
        .where(eq(events.id, existingId));

      // Replace event days wholesale — simpler than diffing.
      // WS2a — shared D1-safe batched insert (was an inline unbatched insert).
      // OPE-433 scope 5 — a promoter replacing their own day set wholesale.
      // The DELETE is what makes this indistinguishable from a fabrication
      // afterwards: the old rows are gone, so only the audit says the hours
      // were REPLACED rather than invented.
      await recordMutation(db, {
        entityType: "event_day",
        entityId: existingId,
        verb: "delete",
        actor: session.user.id,
        note: `promoter day-set replace on event ${existingId}`,
      });
      await db.delete(eventDays).where(eq(eventDays.eventId, existingId));
      await insertEventDaysBatched(db, existingId, eventDaysInput, session.user.id);

      return NextResponse.json({
        id: existingId,
        slug: existing.slug,
        status: finalStatus,
      });
    }

    // ─── Create new draft ──────────────────────────────────────────────
    const baseSlug = createSlug(data.name);
    if (!baseSlug) {
      return NextResponse.json(
        { error: "Event name must contain alphanumeric characters" },
        { status: 400 }
      );
    }

    // WS2a — shared helper (prefix-range query + findUniqueSlug). Was inlined.
    const slug = await resolveUniqueEventSlug(db, baseSlug);

    const newId = crypto.randomUUID();
    // OPE-627 — report-only duplicate check. Writes the flag; merges nothing.
    const possibleDuplicateOf = await detectPossibleDuplicate(db, {
      venueId: data.venueId || null,
      startDate: normalizeEventDate(startDate),
      endDate: normalizeEventDate(endDate),
      name: data.name,
      promoterId: promoter.id,
    });
    await db.insert(events).values({
      possibleDuplicateOf,
      // OPE-433 — named explicitly rather than inherited from the DDL default.
      //
      // A promoter entering their OWN event is the strongest provenance we
      // have, so `true` is right here — but it must be a decision the writer
      // states, not a default it silently picks up. Every other insert path
      // names these; these two were the only ones that did not.
      //
      // `syncEnabled: false` is the more consequential half: a promoter's own
      // data must not be clobbered by a later scraper run. Inheriting `true`
      // meant an importer could overwrite the organizer's own listing.
      datesConfirmed: true,
      syncEnabled: false,
      id: newId,
      name: data.name,
      slug,
      description: data.description,
      venueId: data.venueId || null,
      stateCode: data.stateCode || null,
      isStatewide: data.isStatewide ?? false,
      promoterId: promoter.id,
      // OPE-482: see above — noon-UTC anchor, not midnight.
      startDate: normalizeEventDate(startDate),
      endDate: normalizeEventDate(endDate),
      publicStartDate,
      publicEndDate,
      discontinuousDates: isDiscontinuous,
      categories: JSON.stringify(data.categories ?? []),
      tags: JSON.stringify(data.tags ?? []),
      ticketUrl: data.ticketUrl,
      ticketPriceMinCents: dollarsToCents(data.ticketPriceMin),
      ticketPriceMaxCents: dollarsToCents(data.ticketPriceMax),
      imageUrl: data.imageUrl,
      status: finalStatus,
      vendorFeeMinCents: dollarsToCents(data.vendorFeeMin),
      vendorFeeMaxCents: dollarsToCents(data.vendorFeeMax),
      vendorFeeNotes: data.vendorFeeNotes,
      indoorOutdoor: data.indoorOutdoor,
      estimatedAttendance: data.estimatedAttendance,
      eventScale: data.eventScale,
      applicationDeadline: data.applicationDeadline ? new Date(data.applicationDeadline) : null,
      applicationUrl: data.applicationUrl,
      applicationInstructions: data.applicationInstructions,
      walkInsAllowed: data.walkInsAllowed,
    });

    await recomputeEventCompleteness(db, newId);

    // WS2a — shared D1-safe batched insert (was an inline unbatched insert).
    await insertEventDaysBatched(db, newId, eventDaysInput);

    return NextResponse.json({ id: newId, slug, status: finalStatus }, { status: 201 });
  } catch (error) {
    await logError(db, {
      message: "Failed to save draft",
      error,
      source: "api/promoter/events/draft",
      request,
    });
    return NextResponse.json({ error: "Failed to save draft" }, { status: 500 });
  }
}

/**
 * Load a draft (or any promoter-owned event) for prefilling the wizard.
 * Used by "duplicate" and "continue editing" flows.
 */
export async function GET(request: NextRequest) {
  const db = getCloudflareDb();
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  try {
    const [promoter] = await db
      .select()
      .from(promoters)
      .where(eq(promoters.userId, session.user.id))
      .limit(1);
    if (!promoter) {
      return NextResponse.json({ error: "Promoter profile not found" }, { status: 404 });
    }

    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, id), eq(events.promoterId, promoter.id)))
      .limit(1);
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const days = await db
      .select()
      .from(eventDays)
      .where(eq(eventDays.eventId, id))
      .orderBy(eventDays.date);

    return NextResponse.json({ event, eventDays: days });
  } catch (error) {
    await logError(db, {
      message: "Failed to load draft",
      error,
      source: "api/promoter/events/draft:GET",
      request,
    });
    return NextResponse.json({ error: "Failed to load draft" }, { status: 500 });
  }
}
