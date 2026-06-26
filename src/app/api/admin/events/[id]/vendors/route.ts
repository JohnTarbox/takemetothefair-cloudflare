export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { eventDays, eventVendors, events, vendors } from "@/lib/db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import {
  eventVendorAddSchema,
  eventVendorUpdateSchema,
  validateRequestBody,
} from "@/lib/validations";
import { isValidTransition } from "@/lib/vendor-status";
import { PUBLIC_VENDOR_STATUSES } from "@/lib/constants";
import { logError } from "@/lib/logger";
import { trackVendorStatusChange } from "@/lib/server-analytics";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";

const PUBLIC_VENDOR_SET = new Set<string>(PUBLIC_VENDOR_STATUSES);

// GET - List vendors for an event
export const GET = withAuth<{ id: string }>({ role: "ADMIN" }, async ({ request, db, params }) => {
  const { id } = params;

  try {
    // K18 Phase 2 (drizzle/0114, 2026-06-06): LEFT JOIN event_days so the
    // admin UI gets the resolved date string per row in one roundtrip.
    // event_day_id IS NULL on series-wide links -> eventDayDate is null,
    // which the UI renders as "Regular participants".
    const eventVendorResults = await db
      .select({
        event_vendors: eventVendors,
        vendors: vendors,
        eventDayDate: eventDays.date,
      })
      .from(eventVendors)
      .leftJoin(vendors, eq(eventVendors.vendorId, vendors.id))
      .leftJoin(eventDays, eq(eventVendors.eventDayId, eventDays.id))
      .where(eq(eventVendors.eventId, id))
      .orderBy(sql`${vendors.businessName} COLLATE NOCASE`);

    const vendorList = eventVendorResults
      .filter((ev) => ev.vendors !== null)
      .map((ev) => ({
        ...ev.event_vendors,
        eventDayDate: ev.eventDayDate, // YYYY-MM-DD or null
        vendor: ev.vendors,
      }));

    return NextResponse.json(vendorList);
  } catch (error) {
    await logError(db, {
      message: "Failed to fetch event vendors",
      error,
      source: "api/admin/events/[id]/vendors",
      request,
    });
    return NextResponse.json({ error: "Failed to fetch vendors" }, { status: 500 });
  }
});

// POST - Add a vendor to an event
export const POST = withAuth<{ id: string }>({ role: "ADMIN" }, async ({ request, db, params }) => {
  const { id } = params;

  // Validate request body
  const validation = await validateRequestBody(request, eventVendorAddSchema);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const data = validation.data;

  try {
    // K18 Phase 1 — resolve + validate optional per-occurrence scoping.
    // eventDayId must (a) exist and (b) belong to THIS event. Cross-event
    // ids are rejected before any write. NULL/omitted → series-wide.
    const eventDayId = data.eventDayId ?? null;
    if (eventDayId !== null) {
      const dayRows = await db
        .select({ eventId: eventDays.eventId })
        .from(eventDays)
        .where(eq(eventDays.id, eventDayId))
        .limit(1);
      if (dayRows.length === 0) {
        return NextResponse.json({ error: `event_day not found: ${eventDayId}` }, { status: 400 });
      }
      if (dayRows[0].eventId !== id) {
        return NextResponse.json(
          {
            error: `event_day_id ${eventDayId} belongs to a different event. Cross-event scoping is not allowed.`,
          },
          { status: 400 }
        );
      }
    }

    // Dedup keys on (event_id, vendor_id, event_day_id) — partial-unique
    // indexes (drizzle/0114) allow a vendor to have a series-wide link
    // AND a per-day link for the same event. NULL is a distinct slot.
    const existing = await db
      .select()
      .from(eventVendors)
      .where(
        and(
          eq(eventVendors.eventId, id),
          eq(eventVendors.vendorId, data.vendorId),
          eventDayId === null
            ? isNull(eventVendors.eventDayId)
            : eq(eventVendors.eventDayId, eventDayId)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json(
        {
          error:
            eventDayId === null
              ? "Vendor is already added to this event (series-wide)"
              : "Vendor is already added to this occurrence",
        },
        { status: 400 }
      );
    }

    const eventVendorId = crypto.randomUUID();
    await db.insert(eventVendors).values({
      id: eventVendorId,
      eventId: id,
      vendorId: data.vendorId,
      status: data.status,
      boothInfo: data.boothInfo,
      paymentStatus: data.paymentStatus,
      participationType: data.participationType,
      eventDayId,
    });

    const [newEventVendor] = await db
      .select()
      .from(eventVendors)
      .leftJoin(vendors, eq(eventVendors.vendorId, vendors.id))
      .where(eq(eventVendors.id, eventVendorId))
      .limit(1);

    return NextResponse.json(
      {
        ...newEventVendor.event_vendors,
        vendor: newEventVendor.vendors,
      },
      { status: 201 }
    );
  } catch (error) {
    await logError(db, {
      message: "Failed to add vendor to event",
      error,
      source: "api/admin/events/[id]/vendors",
      request,
    });
    return NextResponse.json({ error: "Failed to add vendor" }, { status: 500 });
  }
});

// PATCH - Update vendor status/info for an event
export const PATCH = withAuth<{ id: string }>(
  { role: "ADMIN" },
  async ({ request, db, session, params }) => {
    const { id } = params;

    // Validate request body
    const validation = await validateRequestBody(request, eventVendorUpdateSchema);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const data = validation.data;

    try {
      const updateData: Record<string, unknown> = {};
      if (data.boothInfo !== undefined) updateData.boothInfo = data.boothInfo;
      if (data.paymentStatus !== undefined) updateData.paymentStatus = data.paymentStatus;
      if (data.participationType !== undefined)
        updateData.participationType = data.participationType;

      // K18 Phase 1 — moving a link between series-wide / per-day / different
      // day. PATCH semantics:
      //   - field omitted → eventDayId unchanged
      //   - field === null → move to series-wide
      //   - field === <uuid> → move to that occurrence (must belong to this event)
      if (data.eventDayId !== undefined) {
        if (data.eventDayId !== null) {
          const dayRows = await db
            .select({ eventId: eventDays.eventId })
            .from(eventDays)
            .where(eq(eventDays.id, data.eventDayId))
            .limit(1);
          if (dayRows.length === 0) {
            return NextResponse.json(
              { error: `event_day not found: ${data.eventDayId}` },
              { status: 400 }
            );
          }
          if (dayRows[0].eventId !== id) {
            return NextResponse.json(
              {
                error: `event_day_id ${data.eventDayId} belongs to a different event. Cross-event scoping is not allowed.`,
              },
              { status: 400 }
            );
          }
        }
        updateData.eventDayId = data.eventDayId;
      }

      // Validate status transition if changing status
      if (data.status) {
        const [current] = await db
          .select({ status: eventVendors.status })
          .from(eventVendors)
          .where(and(eq(eventVendors.id, data.eventVendorId), eq(eventVendors.eventId, id)))
          .limit(1);

        if (!current) {
          return NextResponse.json({ error: "Event vendor not found" }, { status: 404 });
        }

        if (!isValidTransition(current.status, data.status)) {
          return NextResponse.json(
            {
              error: `Cannot transition from ${current.status} to ${data.status}`,
            },
            { status: 400 }
          );
        }

        updateData.status = data.status;

        // Track the status change for analytics
        trackVendorStatusChange(
          db,
          data.eventVendorId,
          id,
          current.status,
          data.status,
          session.user.id
        );
      }

      // Stamp updatedAt so promoter response-time stats can compute decision latency.
      updateData.updatedAt = new Date();

      await db
        .update(eventVendors)
        .set(updateData)
        .where(and(eq(eventVendors.id, data.eventVendorId), eq(eventVendors.eventId, id)));

      const [updated] = await db
        .select()
        .from(eventVendors)
        .leftJoin(vendors, eq(eventVendors.vendorId, vendors.id))
        .where(eq(eventVendors.id, data.eventVendorId))
        .limit(1);

      // IndexNow: when a vendor enters the public set on an event, the public
      // event page changes (the vendor list grows). Re-ping the event URL so
      // search engines pick up the new content. Only fires on transitions INTO
      // the public set — re-edits among public statuses don't ping.
      if (data.status && PUBLIC_VENDOR_SET.has(data.status)) {
        const [eventRow] = await db
          .select({ slug: events.slug })
          .from(events)
          .where(eq(events.id, id))
          .limit(1);
        if (eventRow) {
          const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
          await pingIndexNow(
            db,
            indexNowUrlFor("events", eventRow.slug),
            env,
            "admin-event-vendors"
          );
        }
      }

      return NextResponse.json({
        ...updated.event_vendors,
        vendor: updated.vendors,
      });
    } catch (error) {
      await logError(db, {
        message: "Failed to update event vendor",
        error,
        source: "api/admin/events/[id]/vendors",
        request,
      });
      return NextResponse.json({ error: "Failed to update vendor" }, { status: 500 });
    }
  }
);

// DELETE - Remove a vendor from an event
export const DELETE = withAuth<{ id: string }>(
  { role: "ADMIN" },
  async ({ request, db, params }) => {
    const { id } = params;

    try {
      const { searchParams } = new URL(request.url);
      const eventVendorId = searchParams.get("eventVendorId");

      if (!eventVendorId) {
        return NextResponse.json({ error: "Event vendor ID is required" }, { status: 400 });
      }

      await db
        .delete(eventVendors)
        .where(and(eq(eventVendors.id, eventVendorId), eq(eventVendors.eventId, id)));

      return NextResponse.json({ success: true });
    } catch (error) {
      await logError(db, {
        message: "Failed to remove vendor from event",
        error,
        source: "api/admin/events/[id]/vendors",
        request,
      });
      return NextResponse.json({ error: "Failed to remove vendor" }, { status: 500 });
    }
  }
);
