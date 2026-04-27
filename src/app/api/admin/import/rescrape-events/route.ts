import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events } from "@/lib/db/schema";
import { isAuthorized } from "@/lib/api-auth";
import { logError } from "@/lib/logger";
import { getDetailsScraper } from "@/lib/scrapers/registry";
import { inArray, eq } from "drizzle-orm";

export async function POST(request: Request) {
  const db = getCloudflareDb();

  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as { event_ids?: string[] };
    const eventIds = body.event_ids;

    if (!eventIds || !Array.isArray(eventIds) || eventIds.length === 0) {
      return NextResponse.json(
        { error: "event_ids must be a non-empty array of event IDs" },
        { status: 400 }
      );
    }

    if (eventIds.length > 50) {
      return NextResponse.json({ error: "Maximum 50 events per request" }, { status: 400 });
    }

    // Fetch the requested events
    const targetEvents = await db
      .select({
        id: events.id,
        name: events.name,
        description: events.description,
        sourceName: events.sourceName,
        sourceUrl: events.sourceUrl,
        startDate: events.startDate,
        endDate: events.endDate,
        imageUrl: events.imageUrl,
        ticketUrl: events.ticketUrl,
      })
      .from(events)
      .where(inArray(events.id, eventIds));

    const results = {
      requested: eventIds.length,
      found: targetEvents.length,
      updated: 0,
      skipped: 0,
      errors: [] as string[],
      details: [] as {
        id: string;
        name: string;
        status: "updated" | "skipped" | "no_source" | "no_scraper" | "error";
        fieldsUpdated?: string[];
        error?: string;
      }[],
    };

    for (const event of targetEvents) {
      // Skip events without source info
      if (!event.sourceName || !event.sourceUrl) {
        results.skipped++;
        results.details.push({
          id: event.id,
          name: event.name,
          status: "no_source",
        });
        continue;
      }

      // Look up the detail scraper
      const detailsScraper = getDetailsScraper(event.sourceName);
      if (!detailsScraper) {
        results.skipped++;
        results.details.push({
          id: event.id,
          name: event.name,
          status: "no_scraper",
        });
        continue;
      }

      try {
        const details = await detailsScraper(event.sourceUrl);

        // Build updates for all changed fields (same as sync)
        const updates: Record<string, unknown> = {};
        const fieldsUpdated: string[] = [];

        if (details.description && details.description !== event.description) {
          updates.description = details.description;
          fieldsUpdated.push("description");
        }
        if (
          details.startDate &&
          (!event.startDate || details.startDate.getTime() !== new Date(event.startDate).getTime())
        ) {
          updates.startDate = details.startDate;
          fieldsUpdated.push("startDate");
        }
        if (
          details.endDate &&
          (!event.endDate || details.endDate.getTime() !== new Date(event.endDate).getTime())
        ) {
          updates.endDate = details.endDate;
          fieldsUpdated.push("endDate");
        }
        if (details.imageUrl && details.imageUrl !== event.imageUrl) {
          updates.imageUrl = details.imageUrl;
          fieldsUpdated.push("imageUrl");
        }
        if (details.website && details.website !== event.ticketUrl) {
          updates.ticketUrl = details.website;
          fieldsUpdated.push("ticketUrl");
        }

        if (fieldsUpdated.length > 0) {
          updates.lastSyncedAt = new Date();
          updates.updatedAt = new Date();
          await db.update(events).set(updates).where(eq(events.id, event.id));
          results.updated++;
          results.details.push({
            id: event.id,
            name: event.name,
            status: "updated",
            fieldsUpdated,
          });
        } else {
          // Update sync timestamp even if nothing changed
          await db.update(events).set({ lastSyncedAt: new Date() }).where(eq(events.id, event.id));
          results.skipped++;
          results.details.push({
            id: event.id,
            name: event.name,
            status: "skipped",
          });
        }
      } catch (error) {
        results.errors.push(
          `${event.name}: ${error instanceof Error ? error.message : "Unknown error"}`
        );
        results.details.push({
          id: event.id,
          name: event.name,
          status: "error",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    // Report any requested IDs that weren't found
    const foundIds = new Set(targetEvents.map((e) => e.id));
    for (const id of eventIds) {
      if (!foundIds.has(id)) {
        results.details.push({
          id,
          name: "Unknown",
          status: "error",
          error: "Event not found",
        });
        results.errors.push(`Event ID ${id}: not found`);
      }
    }

    return NextResponse.json(results);
  } catch (error) {
    await logError(db, {
      message: "Error re-scraping events",
      error,
      source: "api/admin/import/rescrape-events",
      request,
    });
    return NextResponse.json({ error: "Failed to re-scrape events" }, { status: 500 });
  }
}
