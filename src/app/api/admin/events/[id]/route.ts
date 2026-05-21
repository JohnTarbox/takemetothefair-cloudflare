import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import {
  events,
  venues,
  promoters,
  eventVendors,
  vendors,
  eventDays,
  eventSlugHistory,
} from "@/lib/db/schema";
import { eq, and, ne } from "drizzle-orm";
import { createSlug, computePublicDates, appendSlugSegment, unsafeSlug } from "@/lib/utils";
import { eventUpdateSchema, validateRequestBody } from "@/lib/validations";
import { logError } from "@/lib/logger";
import { PUBLIC_EVENT_STATUSES } from "@/lib/constants";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";
import { recomputeEventCompleteness } from "@/lib/completeness";
import { parseTimestamp } from "@/lib/datetime";
import { normalizeEventDate } from "@/lib/event-dates";
import { notifyApprovalIfNeeded } from "@/lib/approval-notification";

export const runtime = "edge";

const PUBLIC_EVENT_SET = new Set<string>(PUBLIC_EVENT_STATUSES);

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const db = getCloudflareDb();
  try {
    const eventResults = await db
      .select()
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(eq(events.id, id))
      .limit(1);

    if (eventResults.length === 0) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const eventData = eventResults[0];

    // Get event vendors
    const eventVendorResults = await db
      .select()
      .from(eventVendors)
      .leftJoin(vendors, eq(eventVendors.vendorId, vendors.id))
      .where(eq(eventVendors.eventId, id));

    // Get event days
    const eventDayResults = await db
      .select()
      .from(eventDays)
      .where(eq(eventDays.eventId, id))
      .orderBy(eventDays.date);

    const event = {
      ...eventData.events,
      venue: eventData.venues,
      promoter: eventData.promoters,
      eventVendors: eventVendorResults.map((ev) => ({
        ...ev.event_vendors,
        vendor: ev.vendors,
      })),
      eventDays: eventDayResults,
    };

    return NextResponse.json(event);
  } catch (error) {
    await logError(db, {
      message: "Failed to fetch event",
      error,
      source: "api/admin/events/[id]",
      request,
    });
    return NextResponse.json({ error: "Failed to fetch event" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  // Validate request body
  const validation = await validateRequestBody(request, eventUpdateSchema);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const data = validation.data;

  const db = getCloudflareDb();
  try {
    // Get current event to check if slug needs updating + capture prior values
    // for IndexNow transition / material-change detection below.
    const [currentEvent] = await db
      .select({
        slug: events.slug,
        status: events.status,
        name: events.name,
        description: events.description,
        venueId: events.venueId,
        startDate: events.startDate,
        endDate: events.endDate,
      })
      .from(events)
      .where(eq(events.id, id))
      .limit(1);

    if (!currentEvent) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name) {
      updateData.name = data.name;
      const newSlug = createSlug(data.name);

      // Only update slug if it would change
      if (newSlug !== currentEvent.slug) {
        // Check if new slug already exists for another event
        const slug = newSlug;
        let slugSuffix = 0;
        while (true) {
          const existingSlug = await db
            .select({ id: events.id })
            .from(events)
            .where(
              and(
                eq(events.slug, slugSuffix > 0 ? appendSlugSegment(slug, slugSuffix) : slug),
                ne(events.id, id)
              )
            )
            .limit(1);
          if (existingSlug.length === 0) break;
          slugSuffix++;
        }
        updateData.slug = slugSuffix > 0 ? `${slug}-${slugSuffix}` : slug;
      }
    }
    if (data.description !== undefined) updateData.description = data.description;
    if (data.venueId !== undefined) updateData.venueId = data.venueId || null;
    if (data.isStatewide !== undefined) updateData.isStatewide = data.isStatewide;
    if (data.stateCode !== undefined) updateData.stateCode = data.stateCode || null;

    // If the caller changed the venue without specifying stateCode, derive it from
    // the new venue so state listings stay consistent.
    if (data.venueId && data.stateCode === undefined) {
      const venueRow = await db
        .select({ state: venues.state })
        .from(venues)
        .where(eq(venues.id, data.venueId))
        .limit(1);
      if (venueRow[0]?.state) updateData.stateCode = venueRow[0].state;
    }
    if (data.startDate !== undefined) {
      // Anchor to noon UTC so the date renders as the intended calendar day
      // in every US timezone. `new Date("YYYY-MM-DD")` parses to midnight UTC
      // and shows the previous calendar day under Eastern/Pacific — the bug
      // 582f3156 surfaced when this handler reintroduced midnight-UTC writes
      // on every save. Matches the convention used by the submit path and
      // the noon-UTC backfill (drizzle/0074).
      updateData.startDate = normalizeEventDate(data.startDate);
    }
    if (data.endDate !== undefined) {
      updateData.endDate = normalizeEventDate(data.endDate);
    }
    if (data.datesConfirmed !== undefined) updateData.datesConfirmed = data.datesConfirmed;
    if (data.discontinuousDates !== undefined)
      updateData.discontinuousDates = data.discontinuousDates;

    // Auto-compute startDate/endDate from eventDays when discontinuous.
    // Use normalizeEventDate (noon UTC) rather than parseDateOnly (midnight
    // UTC) so the calendar day renders correctly in US timezones — same fix
    // as the explicit startDate/endDate branches above.
    if (data.discontinuousDates && data.eventDays && data.eventDays.length > 0) {
      const sorted = data.eventDays.map((d) => d.date).sort();
      updateData.startDate = normalizeEventDate(sorted[0]);
      updateData.endDate = normalizeEventDate(sorted[sorted.length - 1]);
    }

    // Auto-compute public date range (excluding vendor-only days)
    if (data.eventDays !== undefined) {
      if (data.eventDays && data.eventDays.length > 0) {
        const { publicStartDate, publicEndDate } = computePublicDates(data.eventDays);
        updateData.publicStartDate = publicStartDate;
        updateData.publicEndDate = publicEndDate;
      } else {
        updateData.publicStartDate = null;
        updateData.publicEndDate = null;
      }
    }

    if (data.categories) updateData.categories = JSON.stringify(data.categories);
    if (data.tags) updateData.tags = JSON.stringify(data.tags);
    if (data.ticketUrl !== undefined) updateData.ticketUrl = data.ticketUrl;
    if (data.ticketPriceMin !== undefined) updateData.ticketPriceMin = data.ticketPriceMin;
    if (data.ticketPriceMax !== undefined) updateData.ticketPriceMax = data.ticketPriceMax;
    if (data.imageUrl !== undefined) updateData.imageUrl = data.imageUrl;
    if (data.featured !== undefined) updateData.featured = data.featured;
    if (data.commercialVendorsAllowed !== undefined)
      updateData.commercialVendorsAllowed = data.commercialVendorsAllowed;
    if (data.status) {
      updateData.status = data.status;
      // Clear gate_flags when admin transitions away from PENDING. The flag
      // represents "needs review before approval"; admin explicitly choosing
      // a non-PENDING status IS the review action. Leaving the flag in place
      // pollutes the /admin/events "Flagged only" filter and the
      // events_pending_review recommendation rule's match set forever after.
      if (data.status !== "PENDING") {
        updateData.gateFlags = null;
      }
    }
    if (data.vendorFeeMin !== undefined) updateData.vendorFeeMin = data.vendorFeeMin;
    if (data.vendorFeeMax !== undefined) updateData.vendorFeeMax = data.vendorFeeMax;
    if (data.vendorFeeNotes !== undefined) updateData.vendorFeeNotes = data.vendorFeeNotes;
    if (data.indoorOutdoor !== undefined) updateData.indoorOutdoor = data.indoorOutdoor;
    if (data.estimatedAttendance !== undefined)
      updateData.estimatedAttendance = data.estimatedAttendance;
    if (data.eventScale !== undefined) updateData.eventScale = data.eventScale;
    if (data.applicationDeadline !== undefined)
      updateData.applicationDeadline = data.applicationDeadline
        ? new Date(data.applicationDeadline)
        : null;
    if (data.applicationUrl !== undefined) updateData.applicationUrl = data.applicationUrl;
    if (data.applicationInstructions !== undefined)
      updateData.applicationInstructions = data.applicationInstructions;
    if (data.walkInsAllowed !== undefined) updateData.walkInsAllowed = data.walkInsAllowed;
    if (data.syncEnabled !== undefined) updateData.syncEnabled = data.syncEnabled;

    // Atomic save: bundle the events UPDATE, the optional slug-history INSERT,
    // and the event_days rewrite (DELETE + chunked INSERTs) into a single
    // db.batch() so a mid-operation failure rolls the whole save back instead
    // of stranding the event with zero event_days. The pre-2026-05-22 sequence
    // ran the eventDays DELETE before any chunked INSERT — a "too many SQL
    // variables" error on the INSERT then left the event with no day rows.
    //
    // D1 caps each statement (including inside a batch) at 100 bound parameters.
    // event_days rows pass 9 columns (8 explicit + the $defaultFn createdAt),
    // so chunks are capped at 11 rows (11 × 9 = 99). Lifting the BATCH_SIZE
    // back up changes the cap, not the limit — the limit is per statement.
    const slugChanged =
      typeof updateData.slug === "string" && updateData.slug !== currentEvent.slug;

    const eventDayRows =
      data.eventDays && data.eventDays.length > 0
        ? data.eventDays.map((day) => ({
            id: crypto.randomUUID(),
            eventId: id,
            date: day.date,
            openTime: day.openTime,
            closeTime: day.closeTime,
            notes: day.notes || null,
            closed: day.closed || false,
            vendorOnly: day.vendorOnly || false,
          }))
        : [];
    const EVENT_DAYS_CHUNK_SIZE = 11;
    const eventDayInsertChunks: Array<typeof eventDayRows> = [];
    for (let i = 0; i < eventDayRows.length; i += EVENT_DAYS_CHUNK_SIZE) {
      eventDayInsertChunks.push(eventDayRows.slice(i, i + EVENT_DAYS_CHUNK_SIZE));
    }

    // db.batch requires a non-empty tuple. The events UPDATE is always present,
    // so cast-spreading the conditional statements is safe.
    const batchStatements = [
      db.update(events).set(updateData).where(eq(events.id, id)),
      ...(slugChanged
        ? [
            db.insert(eventSlugHistory).values({
              eventId: id,
              oldSlug: currentEvent.slug,
              newSlug: unsafeSlug(updateData.slug as string),
              changedAt: new Date(),
              changedBy: session.user.id,
            }),
          ]
        : []),
      ...(data.eventDays !== undefined
        ? [
            db.delete(eventDays).where(eq(eventDays.eventId, id)),
            ...eventDayInsertChunks.map((chunk) => db.insert(eventDays).values(chunk)),
          ]
        : []),
    ] as const;

    try {
      // The events.slug unique constraint surfaces here as an error from the
      // whole batch; convert to a friendly 409. Any other failure rolls back
      // every statement above and falls through to the outer catch.
      await db.batch(batchStatements as unknown as Parameters<typeof db.batch>[0]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint failed: events.slug")) {
        return NextResponse.json(
          { error: "Another event already uses that slug. Pick a different name or slug." },
          { status: 409 }
        );
      }
      throw err;
    }

    // Run after the batch so completeness reflects the fresh row (the score
    // depends on dates, venue, etc., which the UPDATE just changed).
    await recomputeEventCompleteness(db, id);

    const [updatedEvent] = await db.select().from(events).where(eq(events.id, id)).limit(1);

    // IndexNow: ping search engines on lifecycle transitions so they pick up
    // changes within minutes. Three distinct sources let analytics distinguish
    // first-publish, the TENTATIVE→APPROVED upgrade, and material edits to an
    // already-APPROVED event.
    const wasPublic = PUBLIC_EVENT_SET.has(currentEvent.status);
    const newStatus = data.status ?? currentEvent.status;
    const isPublic = PUBLIC_EVENT_SET.has(newStatus);

    let indexNowSource: string | null = null;
    if (!wasPublic && isPublic) {
      indexNowSource = "event-create";
    } else if (currentEvent.status === "TENTATIVE" && newStatus === "APPROVED") {
      indexNowSource = "event-approve";
    } else if (wasPublic && isPublic && newStatus === "APPROVED") {
      const dateChanged = (a: Date | string | null | undefined, b: Date | null) => {
        if (a === undefined) return false;
        // null vs null = unchanged; null vs Date = changed; ms-epoch comparison
        // for two valid dates. parseTimestamp returns null on garbage, so a
        // nonsensical incoming value is treated as null (no change unless the
        // existing value was also non-null).
        const aMs = a ? (parseTimestamp(a)?.getTime() ?? null) : null;
        const bMs = b ? b.getTime() : null;
        return aMs !== bMs;
      };
      const materialChanged =
        (data.name !== undefined && data.name !== currentEvent.name) ||
        (data.description !== undefined && data.description !== currentEvent.description) ||
        (data.venueId !== undefined && (data.venueId || null) !== currentEvent.venueId) ||
        dateChanged(data.startDate, currentEvent.startDate) ||
        dateChanged(data.endDate, currentEvent.endDate) ||
        data.eventDays !== undefined;
      if (materialChanged) indexNowSource = "event-update";
    }

    if (indexNowSource) {
      const slug = (updateData.slug as string | undefined) ?? currentEvent.slug;
      const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
      await pingIndexNow(db, indexNowUrlFor("events", slug), env, indexNowSource);
    }

    // Approval-notification hook. Fires only on non-APPROVED → APPROVED
    // transitions; the helper's own gates (suggester_email present,
    // approval_notified_at NULL) prevent double-sends and notifications
    // for admin-created events. Non-blocking on failure: log + continue
    // so a queue-bound issue doesn't fail the admin's PATCH.
    if (currentEvent.status !== "APPROVED" && newStatus === "APPROVED") {
      try {
        const cfEnv = getCloudflareEnv() as unknown as { EMAIL_JOBS?: Queue<unknown> };
        await notifyApprovalIfNeeded(db, { EMAIL_JOBS: cfEnv.EMAIL_JOBS }, id);
      } catch (notifyError) {
        await logError(db, {
          message: "Failed to enqueue approval notification (non-blocking)",
          error: notifyError,
          source: "api/admin/events/[id]",
          request,
          context: { eventId: id },
        });
      }
    }

    return NextResponse.json(updatedEvent);
  } catch (error) {
    await logError(db, {
      message: "Failed to update event",
      error,
      source: "api/admin/events/[id]",
      request,
    });
    const message = error instanceof Error ? error.message : "Failed to update event";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const db = getCloudflareDb();
  try {
    await db.delete(events).where(eq(events.id, id));
    return NextResponse.json({ success: true });
  } catch (error) {
    await logError(db, {
      message: "Failed to delete event",
      error,
      source: "api/admin/events/[id]",
      request,
    });
    return NextResponse.json({ error: "Failed to delete event" }, { status: 500 });
  }
}
