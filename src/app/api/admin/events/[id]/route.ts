export const dynamic = "force-dynamic";
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
  adminActions,
} from "@/lib/db/schema";
import { eq, and, ne, sql } from "drizzle-orm";
import { createSlug, computePublicDates, appendSlugSegment, unsafeSlug } from "@/lib/utils";
import { eventUpdateSchema, validateRequestBody } from "@/lib/validations";
import { logError } from "@/lib/logger";
import { PUBLIC_EVENT_STATUSES } from "@/lib/constants";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";
import { eventJoinProjection } from "@/lib/db/event-join-projection";
import { recomputeEventCompleteness } from "@/lib/completeness";
import { parseTimestamp } from "@/lib/datetime";
import { normalizeEventDate } from "@/lib/event-dates";
import { notifyApprovalIfNeeded } from "@/lib/approval-notification";
import { evaluateGates, mirroredFieldsChanged } from "@takemetothefair/utils";
import { eventSyndicationStatements } from "@/lib/syndication/outbox";

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
    // Narrow projection via eventJoinProjection — keeps the join under D1's
    // 100-col cap (events 62 + venue 13 + promoter 7 = 82 cols). Was bare
    // .select() = 107 cols post-P3a, silently returning zero rows.
    const eventResults = await db
      .select(eventJoinProjection)
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
      venue: eventData.venue,
      promoter: eventData.promoter,
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
        // Gate re-evaluation inputs (analyst 2026-05-22): used by the
        // post-merge evaluateGates() call below so a PATCH that changes
        // name / dates / deadline / scale re-runs the same gates the
        // ingest paths use, rather than silently bypassing them.
        sourceUrl: events.sourceUrl,
        sourceName: events.sourceName,
        applicationDeadline: events.applicationDeadline,
        eventScale: events.eventScale,
        discontinuousDates: events.discontinuousDates,
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
    // IMG1 §1b Phase 1 (2026-06-08) — focal point clamped to [0,1] here
    // as defense-in-depth: the UI clamps in FocalPointPicker + Zod
    // validates at the schema boundary, but admin PATCH callers can
    // bypass both (curl, MCP tools). The migration's NOT NULL DEFAULT
    // 0.5 means an undefined value falls through cleanly to whatever
    // the row currently holds (we just don't write the column).
    if (typeof data.imageFocalX === "number" && Number.isFinite(data.imageFocalX)) {
      updateData.imageFocalX = Math.max(0, Math.min(1, data.imageFocalX));
    }
    if (typeof data.imageFocalY === "number" && Number.isFinite(data.imageFocalY)) {
      updateData.imageFocalY = Math.max(0, Math.min(1, data.imageFocalY));
    }
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

    // Re-run pre-ingest gates on material edits (analyst 2026-05-22 P2).
    // Before this hook, gates fired only on INSERT — a PATCH that introduced
    // a "Call for Vendors" name, a start_date == application_deadline
    // collision, or other failure patterns would slip through silently
    // because the existing logic ABOVE only *cleared* gate_flags on a
    // PENDING-out transition. Now: if any gate-relevant field changes,
    // evaluate against the post-merge view, persist any firing reasons,
    // and downgrade status to PENDING if the admin tried to set APPROVED
    // or CONFIRMED on a flagged row.
    //
    // Cosmetic edits (venue, image, tags, fees) don't touch gate inputs
    // and so don't trigger re-eval — keeps the gate from firing on every
    // admin edit.
    const gateRelevantChanging =
      data.name !== undefined ||
      data.description !== undefined ||
      data.startDate !== undefined ||
      data.endDate !== undefined ||
      data.applicationDeadline !== undefined ||
      data.eventScale !== undefined ||
      data.discontinuousDates !== undefined ||
      data.eventDays !== undefined;

    let gateFlagsWarning: string[] | null = null;
    if (gateRelevantChanging) {
      const mergedStartDate =
        updateData.startDate !== undefined
          ? (updateData.startDate as Date | null)
          : currentEvent.startDate;
      const mergedEndDate =
        updateData.endDate !== undefined
          ? (updateData.endDate as Date | null)
          : currentEvent.endDate;
      const mergedApplicationDeadline =
        updateData.applicationDeadline !== undefined
          ? (updateData.applicationDeadline as Date | null)
          : currentEvent.applicationDeadline;
      const mergedDescription =
        data.description !== undefined ? data.description : currentEvent.description;
      const mergedEventScale =
        data.eventScale !== undefined ? data.eventScale : currentEvent.eventScale;

      // Recurring-series signals for the duration-too-long-for-scale exemption
      // (analyst 2026-05-26 follow-up). Prefer the incoming PATCH values; fall
      // back to the persisted state. event_days count: use the incoming array
      // when present (admin is about to rewrite the rows); otherwise query
      // the current count to honor existing series.
      const mergedDiscontinuous =
        data.discontinuousDates !== undefined
          ? data.discontinuousDates
          : ((currentEvent as { discontinuousDates?: boolean | null }).discontinuousDates ?? null);
      let mergedEventDaysCount: number;
      if (data.eventDays !== undefined) {
        mergedEventDaysCount = data.eventDays?.length ?? 0;
      } else {
        const [{ count } = { count: 0 }] = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(eventDays)
          .where(eq(eventDays.eventId, id));
        mergedEventDaysCount = count ?? 0;
      }

      const gateResult = evaluateGates({
        name: data.name ?? currentEvent.name,
        sourceUrl: currentEvent.sourceUrl,
        sourceName: currentEvent.sourceName,
        startDate: mergedStartDate,
        endDate: mergedEndDate,
        applicationDeadline: mergedApplicationDeadline,
        description: mergedDescription,
        eventScale: mergedEventScale,
        discontinuousDates: mergedDiscontinuous,
        eventDaysCount: mergedEventDaysCount,
      });

      if (gateResult.route === "PENDING_REVIEW") {
        gateFlagsWarning = gateResult.reasons;
        updateData.gateFlags = JSON.stringify(gateResult.reasons);
        // If the PATCH tried to land the event in APPROVED, downgrade to
        // PENDING. The existing "clear gate_flags when status != PENDING"
        // branch above ran BEFORE this block, so the new gate_flags assigned
        // here overrides that clearing. Order matters.
        const requestedStatus = data.status ?? currentEvent.status;
        if (requestedStatus === "APPROVED") {
          updateData.status = "PENDING";
        }
      }
      // If route === "APPROVED", leave gate_flags alone. The existing
      // status-transition clear above is the right behavior in that case.
    }

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

    // SYN1 — syndication outbox row + per-event version bump, written in the
    // SAME batch so a correction is never dropped. Gated on a mirrored field
    // (name / start / end) actually changing; the venue mirror is only fetched
    // when the gate passes, to keep non-mirrored edits free of extra reads.
    const syndicationChangedFields = Object.keys(updateData).filter(
      (k) => k !== "updatedAt" && k !== "slug"
    );
    let syndicationStmts: unknown[] = [];
    if (mirroredFieldsChanged("event", syndicationChangedFields)) {
      const effectiveVenueId = (
        updateData.venueId !== undefined ? updateData.venueId : currentEvent.venueId
      ) as string | null;
      let venueMirror = null;
      if (effectiveVenueId) {
        const [v] = await db
          .select({
            name: venues.name,
            address: venues.address,
            city: venues.city,
            state: venues.state,
            zip: venues.zip,
          })
          .from(venues)
          .where(eq(venues.id, effectiveVenueId))
          .limit(1);
        venueMirror = v ?? null;
      }
      syndicationStmts = eventSyndicationStatements(db, {
        eventId: id,
        changedFields: syndicationChangedFields,
        event: {
          name: (updateData.name as string) ?? currentEvent.name,
          slug: (updateData.slug as string) ?? currentEvent.slug,
          startDate:
            updateData.startDate !== undefined
              ? (updateData.startDate as Date | null)
              : currentEvent.startDate,
          endDate:
            updateData.endDate !== undefined
              ? (updateData.endDate as Date | null)
              : currentEvent.endDate,
        },
        venue: venueMirror,
      });
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
      ...syndicationStmts,
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

    // J2/C1 (2026-06-12) — log the field-level edit to admin_actions so the
    // admin_actions mining card (docs/j2-admin-actions-mining-card-brief.md) can
    // surface which fields the operator most often corrects after auto-ingest
    // (= where the extractor is weakest). Mirrors the MCP update_event log.
    // `slug` is derived from `name`, so it's excluded to avoid double-counting.
    // Non-fatal: a logging failure must never fail the edit itself.
    const changedFields = Object.keys(updateData).filter((k) => k !== "updatedAt" && k !== "slug");
    if (changedFields.length > 0) {
      try {
        await db.insert(adminActions).values({
          action: "event.update",
          actorUserId: session.user.id,
          targetType: "event",
          targetId: id,
          payloadJson: JSON.stringify({ fields: changedFields, source: "admin_ui" }),
          createdAt: new Date(),
        });
      } catch (err) {
        await logError(db, {
          message: "Failed to write event.update admin_action",
          error: err,
          source: "api/admin/events/[id]",
          request,
        });
      }
    }

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

    // Surface gate flags that fired during this PATCH so the admin UI (and
    // MCP callers) can render a warning. Absence of the field means "no
    // gates fired on this PATCH" — does NOT mean the row is currently free
    // of flags (an older flag may persist in events.gate_flags from ingest).
    if (gateFlagsWarning) {
      return NextResponse.json({
        ...updatedEvent,
        warnings: { gate_flags: gateFlagsWarning },
      });
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
