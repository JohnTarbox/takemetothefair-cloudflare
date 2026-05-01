import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { events, venues, promoters, eventVendors, vendors, eventDays } from "@/lib/db/schema";
import { eq, and, ne } from "drizzle-orm";
import { createSlug, computePublicDates } from "@/lib/utils";
import { eventUpdateSchema, validateRequestBody } from "@/lib/validations";
import { logError } from "@/lib/logger";
import { PUBLIC_EVENT_STATUSES } from "@/lib/constants";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";
import { parseTimestamp, parseDateOnly } from "@/lib/datetime";

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
                eq(events.slug, slugSuffix > 0 ? `${slug}-${slugSuffix}` : slug),
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
      updateData.startDate = data.startDate ? new Date(data.startDate) : null;
    }
    if (data.endDate !== undefined) {
      updateData.endDate = data.endDate ? new Date(data.endDate) : null;
    }
    if (data.datesConfirmed !== undefined) updateData.datesConfirmed = data.datesConfirmed;
    if (data.discontinuousDates !== undefined)
      updateData.discontinuousDates = data.discontinuousDates;

    // Auto-compute startDate/endDate from eventDays when discontinuous
    if (data.discontinuousDates && data.eventDays && data.eventDays.length > 0) {
      const sorted = data.eventDays.map((d) => d.date).sort();
      updateData.startDate = parseDateOnly(sorted[0]);
      updateData.endDate = parseDateOnly(sorted[sorted.length - 1]);
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
    if (data.status) updateData.status = data.status;
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

    await db.update(events).set(updateData).where(eq(events.id, id));

    // Handle eventDays update if provided
    if (data.eventDays !== undefined) {
      // Delete existing event days
      await db.delete(eventDays).where(eq(eventDays.eventId, id));

      // Insert new event days if any (batch to avoid SQLite variable limit)
      if (data.eventDays && data.eventDays.length > 0) {
        const BATCH_SIZE = 100; // Safe batch size (7 vars per day × 100 = 700 < 999 limit)
        const days = data.eventDays.map((day) => ({
          id: crypto.randomUUID(),
          eventId: id,
          date: day.date,
          openTime: day.openTime,
          closeTime: day.closeTime,
          notes: day.notes || null,
          closed: day.closed || false,
          vendorOnly: day.vendorOnly || false,
        }));

        // Insert in batches to avoid "too many SQL variables" error
        for (let i = 0; i < days.length; i += BATCH_SIZE) {
          const batch = days.slice(i, i + BATCH_SIZE);
          await db.insert(eventDays).values(batch);
        }
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
