import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, promoters } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { scrapeMaineFairs, scrapeEventDetails, type ScrapedEvent, type ScrapedVenue } from "@/lib/scrapers/mainefairs";
import { scrapeVtFairs, scrapeNhFairs, scrapeVtNhEventDetails } from "@/lib/scrapers/vtnhfairs";
import { scrapeMafaFairs, scrapeMafaEventDetails } from "@/lib/scrapers/mafa";
import { scrapeMainePublic, scrapeMainePublicEventDetails } from "@/lib/scrapers/mainepublic";
import { createSlug } from "@/lib/utils";

// Helper function to find or create a venue
async function findOrCreateVenue(
  db: ReturnType<typeof getCloudflareDb>,
  scrapedVenue: ScrapedVenue,
  defaultVenueId: string
): Promise<string> {
  if (!scrapedVenue.name) {
    return defaultVenueId;
  }

  // Try to find existing venue by name (case-insensitive search via slug)
  const venueSlug = createSlug(scrapedVenue.name);
  const existingVenue = await db
    .select()
    .from(venues)
    .where(eq(venues.slug, venueSlug))
    .limit(1);

  if (existingVenue.length > 0) {
    return existingVenue[0].id;
  }

  // Create new venue
  const newVenueId = crypto.randomUUID();
  await db.insert(venues).values({
    id: newVenueId,
    name: scrapedVenue.name,
    slug: venueSlug,
    address: scrapedVenue.streetAddress || "",
    city: scrapedVenue.city || "",
    state: scrapedVenue.state || "ME",
    zip: scrapedVenue.zip || "",
    status: "ACTIVE",
  });

  return newVenueId;
}

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
    } else if (source === "mafa.org") {
      result = await scrapeMafaFairs();
    } else if (source === "vtnhfairs.org" || source === "vtnhfairs.org-vt") {
      result = await scrapeVtFairs();
    } else if (source === "vtnhfairs.org-nh") {
      result = await scrapeNhFairs();
    } else if (source === "mainepublic.org") {
      result = await scrapeMainePublic();
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
    const { events: eventsToImport, venueId, promoterId, fetchDetails = false, updateExisting = false } = body as {
      events: ScrapedEvent[];
      venueId: string;
      promoterId: string;
      fetchDetails?: boolean;
      updateExisting?: boolean;
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
      updated: 0,
      skipped: 0,
      venuesCreated: 0,
      errors: [] as string[],
      importedEvents: [] as { id: string; name: string; slug: string }[],
      updatedEvents: [] as { id: string; name: string; slug: string }[],
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

        // Optionally fetch additional details
        let eventData = { ...event };
        if (fetchDetails && event.sourceUrl) {
          // Use the appropriate scraper based on source
          let details: Partial<ScrapedEvent> = {};
          if (event.sourceName === "mainefairs.net") {
            details = await scrapeEventDetails(event.sourceUrl);
          } else if (event.sourceName === "mafa.org") {
            details = await scrapeMafaEventDetails(event.sourceUrl);
          } else if (event.sourceName === "vtnhfairs.org" || event.sourceName === "vtnhfairs.org-vt" || event.sourceName === "vtnhfairs.org-nh") {
            details = await scrapeVtNhEventDetails(event.sourceUrl);
          } else if (event.sourceName === "mainepublic.org") {
            details = await scrapeMainePublicEventDetails(event.sourceUrl);
          }
          eventData = { ...eventData, ...details };
        }

        // Determine venue ID - use scraped venue if available, otherwise default
        let eventVenueId = venueId;
        if (eventData.venue && eventData.venue.name) {
          // Check if this is a new venue we need to create
          const venueSlug = createSlug(eventData.venue.name);
          const existingVenueCheck = await db
            .select()
            .from(venues)
            .where(eq(venues.slug, venueSlug))
            .limit(1);

          if (existingVenueCheck.length === 0) {
            // This will be a new venue
            eventVenueId = await findOrCreateVenue(db, eventData.venue, venueId);
            results.venuesCreated++;
          } else {
            eventVenueId = existingVenueCheck[0].id;
          }
        }

        if (existing.length > 0) {
          // Event already exists
          if (updateExisting) {
            // Update the existing event (including venue if scraped)
            // Use website for ticketUrl (Event Website button), fall back to sourceUrl
            const updateData: Record<string, unknown> = {
              name: eventData.name,
              description: eventData.description || existing[0].description,
              ticketUrl: eventData.website || eventData.ticketUrl || eventData.sourceUrl,
              imageUrl: eventData.imageUrl || existing[0].imageUrl,
              venueId: eventVenueId,
              lastSyncedAt: new Date(),
              updatedAt: new Date(),
            };
            // Only update dates if provided
            if (eventData.startDate) {
              updateData.startDate = new Date(eventData.startDate);
            }
            if (eventData.endDate) {
              updateData.endDate = new Date(eventData.endDate);
            }
            if (eventData.datesConfirmed !== undefined) {
              updateData.datesConfirmed = eventData.datesConfirmed;
            }
            await db.update(events).set(updateData).where(eq(events.id, existing[0].id));
            results.updated++;
            results.updatedEvents.push({
              id: existing[0].id,
              name: eventData.name,
              slug: existing[0].slug,
            });
          } else {
            results.skipped++;
          }
          continue;
        }

        // Generate unique slug for new event
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
        // Use website for ticketUrl (Event Website button), fall back to sourceUrl
        const newEventId = crypto.randomUUID();
        await db.insert(events).values({
          id: newEventId,
          name: eventData.name,
          slug,
          description: eventData.description || `${eventData.name} - imported from ${eventData.sourceName}`,
          promoterId,
          venueId: eventVenueId,
          startDate: eventData.startDate ? new Date(eventData.startDate) : null,
          endDate: eventData.endDate ? new Date(eventData.endDate) : null,
          datesConfirmed: eventData.datesConfirmed ?? (eventData.startDate ? true : false),
          categories: JSON.stringify(["Fair", "Festival"]),
          tags: JSON.stringify(["imported", eventData.sourceName]),
          ticketUrl: eventData.website || eventData.ticketUrl || eventData.sourceUrl,
          imageUrl: eventData.imageUrl,
          status: "APPROVED",
          sourceName: eventData.sourceName,
          sourceUrl: eventData.sourceUrl,
          sourceId: eventData.sourceId,
          syncEnabled: true,
          lastSyncedAt: new Date(),
        });

        results.imported++;
        results.importedEvents.push({
          id: newEventId,
          name: eventData.name,
          slug,
        });
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

        // Use the appropriate scraper based on source
        let details: Partial<ScrapedEvent> = {};
        if (event.sourceName === "mainefairs.net") {
          details = await scrapeEventDetails(event.sourceUrl);
        } else if (event.sourceName === "mafa.org") {
          details = await scrapeMafaEventDetails(event.sourceUrl);
        } else if (event.sourceName === "vtnhfairs.org" || event.sourceName === "vtnhfairs.org-vt" || event.sourceName === "vtnhfairs.org-nh") {
          details = await scrapeVtNhEventDetails(event.sourceUrl);
        } else if (event.sourceName === "mainepublic.org") {
          details = await scrapeMainePublicEventDetails(event.sourceUrl);
        } else {
          // Unknown source, skip
          results.unchanged++;
          continue;
        }

        // Update if we got new details
        if (details.description || details.startDate || details.endDate || details.imageUrl || details.website) {
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
          if (details.website && details.website !== event.ticketUrl) {
            updates.ticketUrl = details.website;
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
