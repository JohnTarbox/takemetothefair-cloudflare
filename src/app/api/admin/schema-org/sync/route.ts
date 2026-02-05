import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, eventSchemaOrg } from "@/lib/db/schema";
import { eq, inArray, isNotNull, isNull, and, sql } from "drizzle-orm";
import { fetchSchemaOrg } from "@/lib/schema-org";
import { logError } from "@/lib/logger";

export const runtime = "edge";

interface SyncRequest {
  eventIds?: string[];
  onlyMissing?: boolean;
  onlyExisting?: boolean;
  limit?: number;
  offset?: number;
}

interface SyncResult {
  eventId: string;
  eventName: string;
  success: boolean;
  status: string;
  error?: string;
}

/**
 * POST /api/admin/schema-org/sync
 * Bulk sync schema.org data for events with ticketUrl
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getCloudflareDb();

  try {
    const body = await request.json() as SyncRequest;
    const { eventIds, onlyMissing = false, onlyExisting = false, limit = 50, offset = 0 } = body;

    // Build query to find events to sync
    let eventsToSync;

    if (eventIds && eventIds.length > 0) {
      // Sync specific events
      eventsToSync = await db
        .select({
          id: events.id,
          name: events.name,
          ticketUrl: events.ticketUrl,
          schemaOrgId: eventSchemaOrg.id,
        })
        .from(events)
        .leftJoin(eventSchemaOrg, eq(events.id, eventSchemaOrg.eventId))
        .where(and(
          inArray(events.id, eventIds),
          isNotNull(events.ticketUrl)
        ))
        .offset(offset)
        .limit(limit);
    } else if (onlyMissing) {
      // Only sync events without schema.org data
      eventsToSync = await db
        .select({
          id: events.id,
          name: events.name,
          ticketUrl: events.ticketUrl,
          schemaOrgId: eventSchemaOrg.id,
        })
        .from(events)
        .leftJoin(eventSchemaOrg, eq(events.id, eventSchemaOrg.eventId))
        .where(and(
          isNotNull(events.ticketUrl),
          isNull(eventSchemaOrg.id)
        ))
        .offset(offset)
        .limit(limit);
    } else if (onlyExisting) {
      // Only sync events that already have schema.org data (status = available)
      eventsToSync = await db
        .select({
          id: events.id,
          name: events.name,
          ticketUrl: events.ticketUrl,
          schemaOrgId: eventSchemaOrg.id,
        })
        .from(events)
        .innerJoin(eventSchemaOrg, eq(events.id, eventSchemaOrg.eventId))
        .where(and(
          isNotNull(events.ticketUrl),
          eq(eventSchemaOrg.status, "available")
        ))
        .offset(offset)
        .limit(limit);
    } else {
      // Sync all events with ticketUrl
      eventsToSync = await db
        .select({
          id: events.id,
          name: events.name,
          ticketUrl: events.ticketUrl,
          schemaOrgId: eventSchemaOrg.id,
        })
        .from(events)
        .leftJoin(eventSchemaOrg, eq(events.id, eventSchemaOrg.eventId))
        .where(isNotNull(events.ticketUrl))
        .offset(offset)
        .limit(limit);
    }

    if (eventsToSync.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No events to sync",
        results: [],
        stats: { total: 0, success: 0, failed: 0, notFound: 0 },
      });
    }

    const results: SyncResult[] = [];
    let successCount = 0;
    let failedCount = 0;
    let notFoundCount = 0;

    // Process events sequentially to avoid rate limiting
    for (const event of eventsToSync) {
      if (!event.ticketUrl) continue;

      try {
        // Fetch schema.org data from the URL
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
          schemaPriceMin: result.data?.priceMin || null,
          schemaPriceMax: result.data?.priceMax || null,
          schemaEventStatus: result.data?.eventStatus || null,
          schemaOrganizerName: result.data?.organizerName || null,
          schemaOrganizerUrl: result.data?.organizerUrl || null,
          status: result.status,
          lastFetchedAt: now,
          lastError: result.error || null,
          updatedAt: now,
        };

        if (event.schemaOrgId) {
          // Update existing record
          await db
            .update(eventSchemaOrg)
            .set({
              ...schemaOrgData,
              fetchCount: sql`${eventSchemaOrg.fetchCount} + 1`,
            })
            .where(eq(eventSchemaOrg.eventId, event.id));
        } else {
          // Insert new record
          await db.insert(eventSchemaOrg).values({
            id: crypto.randomUUID(),
            ...schemaOrgData,
            fetchCount: 1,
            createdAt: now,
          });
        }

        if (result.success) {
          successCount++;
        } else if (result.status === "not_found") {
          notFoundCount++;
        } else {
          failedCount++;
        }

        results.push({
          eventId: event.id,
          eventName: event.name,
          success: result.success,
          status: result.status,
          error: result.error,
        });
      } catch (error) {
        failedCount++;
        results.push({
          eventId: event.id,
          eventName: event.name,
          success: false,
          status: "error",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }

      // Small delay between requests to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return NextResponse.json({
      success: true,
      message: `Synced ${eventsToSync.length} events`,
      results,
      stats: {
        total: eventsToSync.length,
        success: successCount,
        failed: failedCount,
        notFound: notFoundCount,
      },
    });
  } catch (error) {
    await logError(db, {
      message: "Failed to bulk sync schema.org data",
      error,
      source: "api/admin/schema-org/sync",
      request,
    });
    return NextResponse.json(
      { error: "Failed to sync schema.org data" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/admin/schema-org/sync
 * Get stats about schema.org data coverage
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getCloudflareDb();

  try {
    // Count events with ticketUrl
    const [eventsWithTicketUrl] = await db
      .select({ count: sql<number>`count(*)` })
      .from(events)
      .where(isNotNull(events.ticketUrl));

    // Count events with schema.org data
    const [eventsWithSchemaOrg] = await db
      .select({ count: sql<number>`count(*)` })
      .from(eventSchemaOrg)
      .where(eq(eventSchemaOrg.status, "available"));

    // Count events by status
    const statusCounts = await db
      .select({
        status: eventSchemaOrg.status,
        count: sql<number>`count(*)`,
      })
      .from(eventSchemaOrg)
      .groupBy(eventSchemaOrg.status);

    const statusMap: Record<string, number> = {};
    for (const row of statusCounts) {
      statusMap[row.status] = row.count;
    }

    return NextResponse.json({
      eventsWithTicketUrl: eventsWithTicketUrl?.count || 0,
      eventsWithSchemaOrg: eventsWithSchemaOrg?.count || 0,
      statusBreakdown: statusMap,
    });
  } catch (error) {
    await logError(db, {
      message: "Failed to get schema.org stats",
      error,
      source: "api/admin/schema-org/sync",
      request,
    });
    return NextResponse.json(
      { error: "Failed to get schema.org stats" },
      { status: 500 }
    );
  }
}
