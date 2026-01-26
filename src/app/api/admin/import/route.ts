import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, promoters } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { scrapeMaineFairs, scrapeEventDetails, type ScrapedEvent } from "@/lib/scrapers/mainefairs";
import { createSlug } from "@/lib/utils";

export const runtime = "edge";

// GET - Preview events from a source
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const source = searchParams.get("source") || "mainefairs.net";

  try {
    let result;

    if (source === "mainefairs.net") {
      result = await scrapeMaineFairs();
    } else {
      return NextResponse.json({ error: "Unknown source" }, { status: 400 });
    }

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    const db = getCloudflareDb();

    // Check which events already exist
    const existingEvents = await db
      .select({ sourceId: events.sourceId, id: events.id, name: events.name })
      .from(events)
      .where(eq(events.sourceName, source));

    const existingSourceIds = new Set(existingEvents.map(e => e.sourceId));

    // Mark events as new or existing
    const eventsWithStatus = result.events.map(event => ({
      ...event,
      exists: existingSourceIds.has(event.sourceId),
      existingId: existingEvents.find(e => e.sourceId === event.sourceId)?.id,
    }));

    return NextResponse.json({
      source,
      events: eventsWithStatus,
      total: eventsWithStatus.length,
      newCount: eventsWithStatus.filter(e => !e.exists).length,
      existingCount: eventsWithStatus.filter(e => e.exists).length,
    });
  } catch (error) {
    console.error("Error previewing import:", error);
    return NextResponse.json(
      { error: "Failed to preview events" },
      { status: 500 }
    );
  }
}

// POST - Import selected events
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { events: eventsToImport, venueId, promoterId, fetchDetails = false } = body as {
      events: ScrapedEvent[];
      venueId: string;
      promoterId: string;
      fetchDetails?: boolean;
    };

    if (!eventsToImport || eventsToImport.length === 0) {
      return NextResponse.json({ error: "No events to import" }, { status: 400 });
    }

    if (!venueId || !promoterId) {
      return NextResponse.json(
        { error: "Venue and promoter are required" },
        { status: 400 }
      );
    }

    const db = getCloudflareDb();

    // Verify venue and promoter exist
    const venue = await db.select().from(venues).where(eq(venues.id, venueId)).limit(1);
    const promoter = await db.select().from(promoters).where(eq(promoters.id, promoterId)).limit(1);

    if (venue.length === 0) {
      return NextResponse.json({ error: "Venue not found" }, { status: 400 });
    }
    if (promoter.length === 0) {
      return NextResponse.json({ error: "Promoter not found" }, { status: 400 });
    }

    const results = {
      imported: 0,
      skipped: 0,
      errors: [] as string[],
    };

    for (const event of eventsToImport) {
      try {
        // Check if event already exists
        const existing = await db
          .select()
          .from(events)
          .where(
            and(
              eq(events.sourceName, event.sourceName),
              eq(events.sourceId, event.sourceId)
            )
          )
          .limit(1);

        if (existing.length > 0) {
          results.skipped++;
          continue;
        }

        // Optionally fetch additional details
        let eventData = { ...event };
        if (fetchDetails && event.sourceUrl) {
          const details = await scrapeEventDetails(event.sourceUrl);
          eventData = { ...eventData, ...details };
        }

        // Generate unique slug
        let slug = createSlug(eventData.name);
        let slugSuffix = 0;
        while (true) {
          const existingSlug = await db
            .select()
            .from(events)
            .where(eq(events.slug, slugSuffix > 0 ? `${slug}-${slugSuffix}` : slug))
            .limit(1);
          if (existingSlug.length === 0) break;
          slugSuffix++;
        }
        if (slugSuffix > 0) {
          slug = `${slug}-${slugSuffix}`;
        }

        // Insert the event
        await db.insert(events).values({
          name: eventData.name,
          slug,
          description: eventData.description || `${eventData.name} - imported from ${eventData.sourceName}`,
          promoterId,
          venueId,
          startDate: new Date(eventData.startDate),
          endDate: new Date(eventData.endDate),
          categories: JSON.stringify(["Fair", "Festival"]),
          tags: JSON.stringify(["imported", eventData.sourceName]),
          ticketUrl: eventData.ticketUrl || eventData.sourceUrl,
          imageUrl: eventData.imageUrl,
          status: "APPROVED",
          sourceName: eventData.sourceName,
          sourceUrl: eventData.sourceUrl,
          sourceId: eventData.sourceId,
          syncEnabled: true,
          lastSyncedAt: new Date(),
        });

        results.imported++;
      } catch (error) {
        results.errors.push(`Failed to import ${event.name}: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }

    return NextResponse.json(results);
  } catch (error) {
    console.error("Error importing events:", error);
    return NextResponse.json(
      { error: "Failed to import events" },
      { status: 500 }
    );
  }
}

// PATCH - Sync existing events from their sources
export async function PATCH(request: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = getCloudflareDb();

    // Get all events with sync enabled
    const syncableEvents = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.syncEnabled, true),
          // sourceName is not null - we use a simple check
        )
      );

    // Filter to only events that have a source
    const eventsToSync = syncableEvents.filter(e => e.sourceName && e.sourceUrl);

    const results = {
      synced: 0,
      unchanged: 0,
      errors: [] as string[],
    };

    for (const event of eventsToSync) {
      try {
        if (!event.sourceUrl) continue;

        const details = await scrapeEventDetails(event.sourceUrl);

        // Update if we got new details
        if (details.description || details.startDate || details.endDate || details.imageUrl) {
          const updates: Record<string, unknown> = {
            lastSyncedAt: new Date(),
            updatedAt: new Date(),
          };

          if (details.description && details.description !== event.description) {
            updates.description = details.description;
          }
          if (details.startDate && details.startDate.getTime() !== new Date(event.startDate).getTime()) {
            updates.startDate = details.startDate;
          }
          if (details.endDate && details.endDate.getTime() !== new Date(event.endDate).getTime()) {
            updates.endDate = details.endDate;
          }
          if (details.imageUrl && details.imageUrl !== event.imageUrl) {
            updates.imageUrl = details.imageUrl;
          }

          if (Object.keys(updates).length > 2) { // More than just timestamps
            await db.update(events).set(updates).where(eq(events.id, event.id));
            results.synced++;
          } else {
            // Just update the sync timestamp
            await db.update(events).set({
              lastSyncedAt: new Date(),
            }).where(eq(events.id, event.id));
            results.unchanged++;
          }
        } else {
          results.unchanged++;
        }
      } catch (error) {
        results.errors.push(`Failed to sync ${event.name}: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }

    return NextResponse.json(results);
  } catch (error) {
    console.error("Error syncing events:", error);
    return NextResponse.json(
      { error: "Failed to sync events" },
      { status: 500 }
    );
  }
}
