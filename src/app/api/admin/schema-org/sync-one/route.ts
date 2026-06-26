export const dynamic = "force-dynamic";
/**
 * Single-event schema.org sync.
 *
 * This endpoint is the per-event unit of work invoked by
 * `SchemaOrgSyncWorkflow.step.do(...)`. The Workflow orchestrates calls,
 * applies retry, and aggregates results; this endpoint owns the actual
 * "fetch + upsert one event" logic plus access to the canonical
 * `fetchSchemaOrg` helper (which lives in the main app).
 *
 * The old `/api/admin/schema-org/sync` POST iterated a list of events in
 * one Worker invocation, capped at 50 to fit the 30s budget. This
 * endpoint is the single-event extraction of that loop body; the
 * Workflow handles the iteration durably across as many events as needed.
 *
 * Auth: admin session OR X-Internal-Key (MCP Worker calls this from
 * the Workflow). Same pattern as the other admin endpoints the MCP
 * Worker hits (see admin/vendors/[id]/route.ts).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { withAuthorized } from "@/lib/api/with-auth";
import { events, eventSchemaOrg } from "@/lib/db/schema";
import { fetchSchemaOrg } from "@/lib/schema-org";
import { logError } from "@/lib/logger";
import { dollarsToCents } from "@/lib/utils";

const bodySchema = z.object({
  eventId: z.string().min(1),
});

// Accept admin session OR X-Internal-Key (MCP Worker Workflow step). The inner
// try/catch below is kept so the custom {success,eventId,status,error} 500 body
// the Workflow inspects is preserved; withAuthorized's funnel is a backstop.
export const POST = withAuthorized(async ({ request, db }) => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.message },
      { status: 400 }
    );
  }
  const { eventId } = parsed.data;

  try {
    // Look up event + existing schema-org row.
    const rows = await db
      .select({
        id: events.id,
        name: events.name,
        ticketUrl: events.ticketUrl,
        schemaOrgId: eventSchemaOrg.id,
      })
      .from(events)
      .leftJoin(eventSchemaOrg, eq(events.id, eventSchemaOrg.eventId))
      .where(eq(events.id, eventId))
      .limit(1);

    if (rows.length === 0) {
      return NextResponse.json(
        { success: false, eventId, status: "event_not_found", error: "event not found" },
        { status: 404 }
      );
    }
    const event = rows[0];
    if (!event.ticketUrl) {
      return NextResponse.json({
        success: false,
        eventId,
        eventName: event.name,
        status: "no_ticket_url",
        error: "event has no ticketUrl",
      });
    }

    // The real fetch — same helper the old /sync endpoint used (line 6 of
    // the now-deleted route). Handles JSON-LD parsing, redirects, and
    // normalization.
    const result = await fetchSchemaOrg(event.ticketUrl);

    const now = new Date();
    const schemaOrgData = {
      eventId: event.id,
      ticketUrl: event.ticketUrl,
      rawJsonLd: result.rawJsonLd,
      schemaName: result.data?.name || null,
      schemaDescription: result.data?.description || null,
      schemaStartDate: result.data?.startDate || null,
      schemaEndDate: result.data?.endDate || null,
      schemaVenueName: result.data?.venueName || null,
      schemaVenueAddress: result.data?.venueAddress || null,
      schemaVenueCity: result.data?.venueCity || null,
      schemaVenueState: result.data?.venueState || null,
      schemaVenueLat: result.data?.venueLat || null,
      schemaVenueLng: result.data?.venueLng || null,
      schemaImageUrl: result.data?.imageUrl || null,
      schemaTicketUrl: result.data?.ticketUrl || null,
      schemaPriceMinCents: dollarsToCents(result.data?.priceMin),
      schemaPriceMaxCents: dollarsToCents(result.data?.priceMax),
      schemaEventStatus: result.data?.eventStatus || null,
      schemaOrganizerName: result.data?.organizerName || null,
      schemaOrganizerUrl: result.data?.organizerUrl || null,
      status: result.status,
      lastFetchedAt: now,
      lastError: result.error || null,
      updatedAt: now,
    };

    if (event.schemaOrgId) {
      await db
        .update(eventSchemaOrg)
        .set({
          ...schemaOrgData,
          fetchCount: sql`${eventSchemaOrg.fetchCount} + 1`,
        })
        .where(eq(eventSchemaOrg.eventId, event.id));
    } else {
      await db.insert(eventSchemaOrg).values({
        id: crypto.randomUUID(),
        ...schemaOrgData,
        fetchCount: 1,
        createdAt: now,
      });
    }

    return NextResponse.json({
      success: result.success,
      eventId: event.id,
      eventName: event.name,
      status: result.status,
      error: result.error,
    });
  } catch (error) {
    await logError(db, {
      message: "Failed to sync schema.org data for one event",
      error,
      source: "api/admin/schema-org/sync-one",
      request,
      context: { eventId },
    });
    return NextResponse.json(
      {
        success: false,
        eventId,
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
});
