import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, promoters } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { scrapeMaineFairs, scrapeEventDetails, decodeHtmlEntities, type ScrapedEvent, type ScrapedVenue } from "@/lib/scrapers/mainefairs";
import { scrapeVtFairs, scrapeNhFairs, scrapeVtNhEventDetails } from "@/lib/scrapers/vtnhfairs";
import { scrapeMafaFairs, scrapeMafaEventDetails } from "@/lib/scrapers/mafa";
import { scrapeMainePublic, scrapeMainePublicEventDetails } from "@/lib/scrapers/mainepublic";
import { scrapeMaineMade, scrapeMaineMadeEventDetails } from "@/lib/scrapers/mainemade";
import { scrapeNewEnglandCraftFairs, scrapeNewEnglandCraftFairsEventDetails } from "@/lib/scrapers/newenglandcraftfairs";
import { scrapeFairsAndFestivals, scrapeFairsAndFestivalsUrl, scrapeEventDetails as scrapeFairsAndFestivalsEventDetails } from "@/lib/scrapers/fairsandfestivals";
import { createSlug } from "@/lib/utils";

// Helper function to find or create a venue
// Matches on BOTH name (slug) AND city to avoid matching venues with same name in different cities
async function findOrCreateVenue(
  db: ReturnType<typeof getCloudflareDb>,
  scrapedVenue: ScrapedVenue,
  defaultVenueId: string | null
): Promise<string | null> {
  if (!scrapedVenue.name) {
    return defaultVenueId;
  }

  // Decode HTML entities in venue name to ensure consistent matching
  const decodedName = decodeHtmlEntities(scrapedVenue.name);
  const venueSlug = createSlug(decodedName);
  const venueCity = (scrapedVenue.city || "").toLowerCase().trim();
  const venueState = (scrapedVenue.state || "").toUpperCase().trim();

  // Try to find existing venue by slug
  const existingVenues = await db
    .select()
    .from(venues)
    .where(eq(venues.slug, venueSlug));

  // Look for a venue with matching city (if we have city info)
  if (existingVenues.length > 0 && venueCity) {
    const matchingVenue = existingVenues.find(
      (v) => v.city.toLowerCase().trim() === venueCity
    );
    if (matchingVenue) {
      return matchingVenue.id;
    }
    // Name matches but city doesn't - will create new venue with unique slug below
  } else if (existingVenues.length > 0 && !venueCity) {
    // No city info from scraper - try to match by state if available
    if (venueState) {
      const matchingVenue = existingVenues.find(
        (v) => v.state.toUpperCase().trim() === venueState
      );
      if (matchingVenue) {
        console.log(`[findOrCreateVenue] Matched existing venue "${matchingVenue.name}" by state ${venueState}`);
        return matchingVenue.id;
      }
    }
    // No state match either - just use the first existing venue with this slug
    // This is safer than creating duplicates with no distinguishing info
    console.log(`[findOrCreateVenue] Using existing venue "${existingVenues[0].name}" for "${decodedName}" (no city/state match available)`);
    return existingVenues[0].id;
  }

  // No existing venue found, or existing venue has different city - create new one
  // Generate unique slug if needed
  let finalSlug = venueSlug;
  if (existingVenues.length > 0) {
    // Slug already exists - make it unique
    if (venueCity) {
      finalSlug = `${venueSlug}-${createSlug(venueCity)}`;
    } else if (venueState) {
      finalSlug = `${venueSlug}-${venueState.toLowerCase()}`;
    } else {
      finalSlug = `${venueSlug}-${crypto.randomUUID().substring(0, 8)}`;
    }

    // Check if this slug also exists, add random suffix if needed
    const slugCheck = await db
      .select()
      .from(venues)
      .where(eq(venues.slug, finalSlug))
      .limit(1);
    if (slugCheck.length > 0) {
      finalSlug = `${finalSlug}-${crypto.randomUUID().substring(0, 8)}`;
    }
  }

  const newVenueId = crypto.randomUUID();
  await db.insert(venues).values({
    id: newVenueId,
    name: decodedName,
    slug: finalSlug,
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
  const fetchDetails = searchParams.get("fetchDetails") === "true";
  const customUrl = searchParams.get("customUrl");

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
    } else if (source === "mainemade.com") {
      result = await scrapeMaineMade();
    } else if (source === "newenglandcraftfairs.com") {
      result = await scrapeNewEnglandCraftFairs();
    } else if (source.startsWith("fairsandfestivals.net")) {
      // Support custom URL or state-specific sources like "fairsandfestivals.net-ME"
      if (source === "fairsandfestivals.net-custom" && customUrl) {
        try {
          result = await scrapeFairsAndFestivalsUrl(customUrl);
        } catch (scrapeError) {
          console.error("[FairsAndFestivals Custom URL] Scrape error:", scrapeError);
          return NextResponse.json(
            { error: `Failed to scrape custom URL: ${scrapeError instanceof Error ? scrapeError.message : "Unknown error"}` },
            { status: 500 }
          );
        }
      } else {
        const stateMatch = source.match(/fairsandfestivals\.net-([A-Z]{2})/i);
        const stateCode = stateMatch ? stateMatch[1].toUpperCase() : "ME"; // Default to Maine
        result = await scrapeFairsAndFestivals(stateCode);
      }
    } else {
      return NextResponse.json({ error: "Unknown source" }, { status: 400 });
    }

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    // Optionally fetch details for each event
    let eventsWithDetails = result.events;
    if (fetchDetails) {
      eventsWithDetails = await Promise.all(
        result.events.map(async (event) => {
          if (!event.sourceUrl) return event;

          try {
            let details: Partial<ScrapedEvent> = {};
            if (source === "mainefairs.net") {
              details = await scrapeEventDetails(event.sourceUrl);
            } else if (source === "mafa.org") {
              details = await scrapeMafaEventDetails(event.sourceUrl);
            } else if (source === "vtnhfairs.org" || source === "vtnhfairs.org-vt" || source === "vtnhfairs.org-nh") {
              details = await scrapeVtNhEventDetails(event.sourceUrl);
            } else if (source === "mainepublic.org") {
              details = await scrapeMainePublicEventDetails(event.sourceUrl);
            } else if (source === "mainemade.com") {
              details = await scrapeMaineMadeEventDetails(event.sourceUrl);
            } else if (source === "newenglandcraftfairs.com") {
              details = await scrapeNewEnglandCraftFairsEventDetails(event.sourceUrl);
            } else if (source.startsWith("fairsandfestivals.net")) {
              details = await scrapeFairsAndFestivalsEventDetails(event.sourceUrl);
            }
            return { ...event, ...details };
          } catch (error) {
            console.error(`Error fetching details for ${event.name}:`, error);
            return event;
          }
        })
      );
    }

    const db = getCloudflareDb();

    // Check which events already exist
    const existingEvents = await db
      .select({ sourceId: events.sourceId, id: events.id, name: events.name })
      .from(events)
      .where(eq(events.sourceName, source));

    const existingSourceIds = new Set(existingEvents.map(e => e.sourceId));

    // Mark events as new or existing
    const eventsWithStatus = eventsWithDetails.map(event => ({
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
      venueId?: string;
      promoterId: string;
      fetchDetails?: boolean;
      updateExisting?: boolean;
    };

    if (!eventsToImport || eventsToImport.length === 0) {
      return NextResponse.json({ error: "No events to import" }, { status: 400 });
    }

    if (!promoterId) {
      return NextResponse.json(
        { error: "Promoter is required" },
        { status: 400 }
      );
    }

    const db = getCloudflareDb();

    // Verify venue exists if provided
    if (venueId) {
      const venue = await db.select().from(venues).where(eq(venues.id, venueId)).limit(1);
      if (venue.length === 0) {
        return NextResponse.json({ error: "Venue not found" }, { status: 400 });
      }
    }

    // Verify promoter exists
    const promoter = await db.select().from(promoters).where(eq(promoters.id, promoterId)).limit(1);
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
          try {
            if (event.sourceName === "mainefairs.net") {
              details = await scrapeEventDetails(event.sourceUrl);
            } else if (event.sourceName === "mafa.org") {
              details = await scrapeMafaEventDetails(event.sourceUrl);
            } else if (event.sourceName === "vtnhfairs.org" || event.sourceName === "vtnhfairs.org-vt" || event.sourceName === "vtnhfairs.org-nh") {
              details = await scrapeVtNhEventDetails(event.sourceUrl);
            } else if (event.sourceName === "mainepublic.org") {
              details = await scrapeMainePublicEventDetails(event.sourceUrl);
            } else if (event.sourceName === "mainemade.com") {
              details = await scrapeMaineMadeEventDetails(event.sourceUrl);
            } else if (event.sourceName === "newenglandcraftfairs.com") {
              details = await scrapeNewEnglandCraftFairsEventDetails(event.sourceUrl);
            } else if (event.sourceName.startsWith("fairsandfestivals.net")) {
              details = await scrapeFairsAndFestivalsEventDetails(event.sourceUrl);
            }
            // Log if scraper didn't find dates
            if (!details.startDate && event.sourceName === "mainepublic.org") {
              console.log(`[Import Debug] No dates found for ${event.name} from ${event.sourceUrl}`);
              console.log(`[Import Debug] Details returned:`, JSON.stringify(details));
            }
          } catch (scrapeError) {
            console.error(`[Import Debug] Scraper error for ${event.name}:`, scrapeError);
            results.errors.push(`Scraper error for ${event.name}: ${scrapeError instanceof Error ? scrapeError.message : "Unknown error"}`);
          }
          eventData = { ...eventData, ...details };
        }

        // Determine venue ID - use scraped venue if available, otherwise default (can be null)
        let eventVenueId: string | null = venueId || null;
        if (eventData.venue && eventData.venue.name) {
          // Use findOrCreateVenue which matches on BOTH name AND city
          const venueCity = (eventData.venue.city || "").toLowerCase().trim();
          const decodedVenueName = decodeHtmlEntities(eventData.venue.name);
          const venueSlug = createSlug(decodedVenueName);

          console.log(`[Venue Match] Event: ${eventData.name}, Venue: ${decodedVenueName}, City from scraper: "${venueCity}"`);

          // Check if venue exists with matching name AND city
          const existingVenues = await db
            .select()
            .from(venues)
            .where(eq(venues.slug, venueSlug));

          console.log(`[Venue Match] Found ${existingVenues.length} existing venue(s) with slug "${venueSlug}"`);
          existingVenues.forEach((v, i) => {
            console.log(`[Venue Match]   ${i + 1}. "${v.name}" in "${v.city}", ${v.state} (id: ${v.id})`);
          });

          let matchedVenue = null;
          if (existingVenues.length > 0 && venueCity) {
            // Look for venue with matching city
            matchedVenue = existingVenues.find(
              (v) => v.city.toLowerCase().trim() === venueCity
            );
            if (matchedVenue) {
              console.log(`[Venue Match] Matched existing venue by name+city: ${matchedVenue.id}`);
            } else {
              console.log(`[Venue Match] No venue matched city "${venueCity}" - will create new`);
            }
          } else if (existingVenues.length > 0 && !venueCity) {
            // No city from scraper - DON'T fall back to first match, create new venue instead
            // This prevents matching "DoubleTree Portland" when we don't know the city
            console.log(`[Venue Match] No city from scraper - will create new venue to avoid wrong match`);
            matchedVenue = null;
          }

          if (matchedVenue) {
            eventVenueId = matchedVenue.id;
          } else {
            // Create new venue (either no match at all, or same name but different city, or no city info)
            const newVenueId = await findOrCreateVenue(db, eventData.venue, venueId || null);
            if (newVenueId) {
              eventVenueId = newVenueId;
              results.venuesCreated++;
              console.log(`[Venue Match] Created new venue: ${newVenueId}`);
            }
          }
        }
        // eventVenueId can be null - event will be created without a venue

        if (existing.length > 0) {
          // Event already exists
          if (updateExisting) {
            // Update the existing event (including venue if scraped)
            // Use website for ticketUrl (Event Website button), fall back to sourceUrl
            // Decode HTML entities in event name
            const decodedEventName = decodeHtmlEntities(eventData.name);
            const decodedDescription = eventData.description ? decodeHtmlEntities(eventData.description) : existing[0].description;
            const updateData: Record<string, unknown> = {
              name: decodedEventName,
              description: decodedDescription,
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
            // Update commercial vendors allowed if provided
            if (eventData.commercialVendorsAllowed !== undefined) {
              updateData.commercialVendorsAllowed = eventData.commercialVendorsAllowed;
            }
            await db.update(events).set(updateData).where(eq(events.id, existing[0].id));
            results.updated++;
            results.updatedEvents.push({
              id: existing[0].id,
              name: decodedEventName,
              slug: existing[0].slug,
            });
          } else {
            results.skipped++;
          }
          continue;
        }

        // Decode HTML entities in event name for new events
        const decodedNewEventName = decodeHtmlEntities(eventData.name);

        // Generate unique slug for new event
        let slug = createSlug(decodedNewEventName);
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
        const decodedNewDescription = eventData.description
          ? decodeHtmlEntities(eventData.description)
          : `${decodedNewEventName} - imported from ${eventData.sourceName}`;
        const newEventId = crypto.randomUUID();
        await db.insert(events).values({
          id: newEventId,
          name: decodedNewEventName,
          slug,
          description: decodedNewDescription,
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
          commercialVendorsAllowed: eventData.commercialVendorsAllowed ?? true,
        });

        results.imported++;
        results.importedEvents.push({
          id: newEventId,
          name: decodedNewEventName,
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
export async function PATCH(_request: Request) {
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
        } else if (event.sourceName === "mainemade.com") {
          details = await scrapeMaineMadeEventDetails(event.sourceUrl);
        } else if (event.sourceName === "newenglandcraftfairs.com") {
          details = await scrapeNewEnglandCraftFairsEventDetails(event.sourceUrl);
        } else if (event.sourceName?.startsWith("fairsandfestivals.net")) {
          details = await scrapeFairsAndFestivalsEventDetails(event.sourceUrl);
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
          if (details.startDate && (!event.startDate || details.startDate.getTime() !== new Date(event.startDate).getTime())) {
            updates.startDate = details.startDate;
          }
          if (details.endDate && (!event.endDate || details.endDate.getTime() !== new Date(event.endDate).getTime())) {
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
