export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { detectPossibleDuplicate } from "@/lib/duplicates/venue-date-collision";
import { withAuth } from "@/lib/api/with-auth";
import { recordMutation } from "@/lib/audit/record-mutation";
import { events, venues, promoters, eventDays } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import type { ScrapedEvent, ScrapedVenue } from "@/lib/scrapers/types";
import type { Slug } from "@takemetothefair/utils";
import { decodeHtmlEntities, sanitizeScrapedDescription } from "@/lib/scrapers/utils";
import {
  getScraper,
  parseSourceOptions,
  getDetailsScraper,
  getScraperRetirement,
} from "@/lib/scrapers/registry";
import { createSlug, appendSlugSegment, unsafeSlug, slugCandidates } from "@/lib/utils";
import { normalizeEventDate } from "@/lib/event-dates";
import { logError } from "@/lib/logger";
import { recomputeEventCompleteness } from "@/lib/completeness";
import { logEnrichment } from "@/lib/enrichment-log";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { geocodeNewVenue } from "@/lib/venues/geocode-one";
import {
  loadClassifications,
  gateUrlForField,
  shouldIngestFromSource,
} from "@/lib/url-classification";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";
import { evaluateGates } from "@/lib/event-date-gates";
import { classifySource } from "@/lib/source-classification";

// Helper function to find or create a venue
// Matches on BOTH name (slug) AND city to avoid matching venues with same name in different cities
// Returns { id, newSlug } where newSlug is set only when this call inserted a new venue.
async function findOrCreateVenue(
  db: ReturnType<typeof getCloudflareDb>,
  scrapedVenue: ScrapedVenue,
  defaultVenueId: string | null
): Promise<{ id: string | null; newSlug: string | null }> {
  if (!scrapedVenue.name) {
    return { id: defaultVenueId, newSlug: null };
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
    .where(eq(venues.slug, unsafeSlug(venueSlug)));

  // Look for a venue with matching city (if we have city info)
  if (existingVenues.length > 0 && venueCity) {
    const matchingVenue = existingVenues.find((v) => v.city.toLowerCase().trim() === venueCity);
    if (matchingVenue) {
      return { id: matchingVenue.id, newSlug: null };
    }
    // Name matches but city doesn't - will create new venue with unique slug below
  } else if (existingVenues.length > 0 && !venueCity) {
    // No city info from scraper - try to match by state if available
    if (venueState) {
      const matchingVenue = existingVenues.find((v) => v.state.toUpperCase().trim() === venueState);
      if (matchingVenue) {
        console.warn(
          `[findOrCreateVenue] Matched existing venue "${matchingVenue.name}" by state ${venueState}`
        );
        return { id: matchingVenue.id, newSlug: null };
      }
    }
    // No state match either - just use the first existing venue with this slug
    // This is safer than creating duplicates with no distinguishing info
    console.warn(
      `[findOrCreateVenue] Using existing venue "${existingVenues[0].name}" for "${decodedName}" (no city/state match available)`
    );
    return { id: existingVenues[0].id, newSlug: null };
  }

  // No existing venue found, or existing venue has different city - create new one
  // Generate unique slug if needed
  // OPE-665 — one collision strategy across every venue-creating path: the
  // numeric suffix from `venue-minting.ts`. This block previously appended the
  // city, else the state, else 8 random hex characters — three shapes, chosen
  // by which fields the scraper happened to supply.
  //
  // The random fallback was the real problem. It is not deterministic, so the
  // same import retried produced a DIFFERENT public URL, and the slug it
  // produced can never be read or guessed. It existed only because city and
  // state can be absent; a numeric suffix always can be formed, so nothing
  // needs to fall back to randomness.
  //
  // The old shape also checked its first candidate and then, on a clash,
  // appended a uuid WITHOUT re-checking — so the value that reached the insert
  // was the one nobody verified. Iterating the generator probes the candidate
  // it is about to use, every time.
  let finalSlug: Slug | null = null;
  for (const candidate of slugCandidates(unsafeSlug(venueSlug))) {
    const clash = await db
      .select({ id: venues.id })
      .from(venues)
      .where(eq(venues.slug, candidate))
      .limit(1);
    if (clash.length === 0) {
      finalSlug = candidate;
      break;
    }
  }
  if (!finalSlug) {
    // Refuse rather than invent. The column is UNIQUE and NOT NULL, so an
    // unverified slug here is a failed insert at best.
    console.error(`[findOrCreateVenue] slug candidates exhausted for "${decodedName}"`);
    return { id: defaultVenueId, newSlug: null };
  }

  const newVenueId = crypto.randomUUID();
  // OPE-433 scope 5 — name the importer. The ticket's specimen listed "the
  // mafa.org importer running with sync_enabled=1" as one of three
  // indistinguishable candidates for an unattributed production write; an
  // importer that says which importer it is removes it from that list.
  await recordMutation(db, {
    entityType: "venue",
    entityId: newVenueId,
    verb: "create",
    actor: "admin-import",
    after: { name: decodedName, city: scrapedVenue.city, state: scrapedVenue.state },
    note: "scraper import venue create",
  });
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

  // OPE-408 — routed through the CONFIDENCE GATE.
  //
  // This block used to call `geocodeAddress`, which drops `locationType` and
  // stores Google's top hit unconditionally. Google's fallback for a miss is a
  // CITY CENTROID (`APPROXIMATE`) — a confident-looking pin that can sit miles
  // from a rural fairground's gate, which then silently mis-attributes photos.
  // The geocode-venues route has refused those since OPE-207 ("better a flagged
  // blank than a wrong pin") and OPE-219 exists because forcing them produced
  // four wrong pins that had to be reverted. This ingest path never had that
  // gate, so it was writing exactly what the sweep refuses.
  //
  // geocodeNewVenue applies preflight + judge and never throws, so the venue is
  // still created if Google is slow or the answer is untrustworthy.
  await geocodeNewVenue(db, newVenueId, getCloudflareEnv().GOOGLE_MAPS_API_KEY);

  return { id: newVenueId, newSlug: finalSlug };
}

// GET - Preview events from a source
export const GET = withAuth({ role: "ADMIN" }, async ({ request, db }) => {
  const { searchParams } = new URL(request.url);
  const source = searchParams.get("source") || "mainefairs.net";
  const fetchDetails = searchParams.get("fetchDetails") === "true";
  const customUrl = searchParams.get("customUrl");

  try {
    let result;

    const scraper = getScraper(source);
    if (!scraper) {
      return NextResponse.json({ error: "Unknown source" }, { status: 400 });
    }

    const options = parseSourceOptions(source, customUrl);
    if (source === "fairsandfestivals.net-custom" && options.customUrl) {
      try {
        result = await scraper.scrape(options);
      } catch (scrapeError) {
        await logError(db, {
          message: "[FairsAndFestivals Custom URL] Scrape error",
          error: scrapeError,
          source: "api/admin/import",
          request,
        });
        return NextResponse.json(
          {
            error: `Failed to scrape custom URL: ${scrapeError instanceof Error ? scrapeError.message : "Unknown error"}`,
          },
          { status: 500 }
        );
      }
    } else {
      result = await scraper.scrape(options);
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
            const detailsScraper = getDetailsScraper(source);
            const details: Partial<ScrapedEvent> = detailsScraper
              ? await detailsScraper(event.sourceUrl)
              : {};
            return { ...event, ...details };
          } catch (error) {
            await logError(db, {
              message: `Error fetching details for ${event.name}`,
              error,
              source: "api/admin/import",
              request,
            });
            return event;
          }
        })
      );
    }

    // Check which events already exist
    const existingEvents = await db
      .select({ sourceId: events.sourceId, id: events.id, name: events.name })
      .from(events)
      .where(eq(events.sourceName, source));

    const existingSourceIds = new Set(existingEvents.map((e) => e.sourceId));

    // Mark events as new or existing
    const eventsWithStatus = eventsWithDetails.map((event) => ({
      ...event,
      exists: existingSourceIds.has(event.sourceId),
      existingId: existingEvents.find((e) => e.sourceId === event.sourceId)?.id,
    }));

    return NextResponse.json({
      source,
      events: eventsWithStatus,
      total: eventsWithStatus.length,
      newCount: eventsWithStatus.filter((e) => !e.exists).length,
      existingCount: eventsWithStatus.filter((e) => e.exists).length,
    });
  } catch (error) {
    await logError(db, {
      message: "Error previewing import",
      error,
      source: "api/admin/import",
      request,
    });
    return NextResponse.json({ error: "Failed to preview events" }, { status: 500 });
  }
});

// POST - Import selected events
export const POST = withAuth({ role: "ADMIN" }, async ({ request, db }) => {
  try {
    const body = await request.json();
    const {
      events: eventsToImport,
      venueId,
      promoterId,
      fetchDetails = false,
      updateExisting = false,
    } = body as {
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
      return NextResponse.json({ error: "Promoter is required" }, { status: 400 });
    }

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

    // Track slugs of newly-created venues so we can batch-ping IndexNow at the end.
    const newVenueSlugsForIndexNow: string[] = [];

    // Load URL domain classifications once for the whole batch — used to gate
    // ticket_url and source_url against known-aggregator domains.
    const urlClassifications = await loadClassifications(db);

    for (const event of eventsToImport) {
      try {
        // Source-level skip: if the event's source domain is classified with
        // use_as_source=0, refuse to ingest. Distinct from field-level gating
        // (which only nulls the field) — bad-source events shouldn't enter the DB.
        if (!shouldIngestFromSource(event.sourceUrl, urlClassifications)) {
          results.skipped++;
          results.errors.push(`Skipped ${event.name}: source domain blocked by classification`);
          continue;
        }

        // Check if event already exists
        const existing = await db
          .select()
          .from(events)
          .where(and(eq(events.sourceName, event.sourceName), eq(events.sourceId, event.sourceId)))
          .limit(1);

        // Optionally fetch additional details
        let eventData = { ...event };
        if (fetchDetails && event.sourceUrl) {
          // Use the appropriate scraper based on source
          let details: Partial<ScrapedEvent> = {};
          try {
            const detailsScraper = getDetailsScraper(event.sourceName);
            if (detailsScraper) {
              details = await detailsScraper(event.sourceUrl);
            }
            // Log if scraper didn't find dates
            if (!details.startDate && event.sourceName === "mainepublic.org") {
              console.warn(
                `[Import Debug] No dates found for ${event.name} from ${event.sourceUrl}`
              );
              console.warn(`[Import Debug] Details returned:`, JSON.stringify(details));
            }
          } catch (scrapeError) {
            await logError(db, {
              message: `[Import Debug] Scraper error for ${event.name}`,
              error: scrapeError,
              source: "api/admin/import",
              request,
            });
            results.errors.push(
              `Scraper error for ${event.name}: ${scrapeError instanceof Error ? scrapeError.message : "Unknown error"}`
            );
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

          console.warn(
            `[Venue Match] Event: ${eventData.name}, Venue: ${decodedVenueName}, City from scraper: "${venueCity}"`
          );

          // Check if venue exists with matching name AND city
          const existingVenues = await db
            .select()
            .from(venues)
            .where(eq(venues.slug, unsafeSlug(venueSlug)));

          console.warn(
            `[Venue Match] Found ${existingVenues.length} existing venue(s) with slug "${venueSlug}"`
          );
          existingVenues.forEach((v, i) => {
            console.warn(
              `[Venue Match]   ${i + 1}. "${v.name}" in "${v.city}", ${v.state} (id: ${v.id})`
            );
          });

          let matchedVenue = null;
          if (existingVenues.length > 0 && venueCity) {
            // Look for venue with matching city
            matchedVenue = existingVenues.find((v) => v.city.toLowerCase().trim() === venueCity);
            if (matchedVenue) {
              console.warn(`[Venue Match] Matched existing venue by name+city: ${matchedVenue.id}`);
            } else {
              console.warn(`[Venue Match] No venue matched city "${venueCity}" - will create new`);
            }
          } else if (existingVenues.length > 0 && !venueCity) {
            // No city from scraper - DON'T fall back to first match, create new venue instead
            // This prevents matching "DoubleTree Portland" when we don't know the city
            console.warn(
              `[Venue Match] No city from scraper - will create new venue to avoid wrong match`
            );
            matchedVenue = null;
          }

          if (matchedVenue) {
            eventVenueId = matchedVenue.id;
          } else {
            // Create new venue (either no match at all, or same name but different city, or no city info)
            const venueResult = await findOrCreateVenue(db, eventData.venue, venueId || null);
            if (venueResult.id) {
              eventVenueId = venueResult.id;
              if (venueResult.newSlug) {
                results.venuesCreated++;
                newVenueSlugsForIndexNow.push(venueResult.newSlug);
                console.warn(`[Venue Match] Created new venue: ${venueResult.id}`);
              }
            }
          }
        }
        // eventVenueId can be null - event will be created without a venue

        if (existing.length > 0) {
          // Event already exists
          // Respect syncEnabled=false — admins set this after hand-editing so re-imports don't clobber enrichments
          if (updateExisting && existing[0].syncEnabled !== false) {
            // Update the existing event (including venue if scraped)
            // Use website for ticketUrl (Event Website button), fall back to sourceUrl
            // Decode HTML entities in event name
            const decodedEventName = decodeHtmlEntities(eventData.name);
            const decodedDescription = eventData.description
              ? sanitizeScrapedDescription(eventData.description)
              : existing[0].description;
            const updateData: Record<string, unknown> = {
              name: decodedEventName,
              description: decodedDescription,
              ticketUrl: gateUrlForField(
                eventData.website || eventData.ticketUrl || eventData.sourceUrl,
                "ticket",
                urlClassifications
              ),
              imageUrl: eventData.imageUrl || existing[0].imageUrl,
              venueId: eventVenueId,
              lastSyncedAt: new Date(),
              updatedAt: new Date(),
            };
            // Only update dates if provided. A3 (Dev backlog 2026-06-05):
            // route through normalizeEventDate so bare YYYY-MM-DD lands at
            // noon UTC (canonical anchor).
            const updateStart = normalizeEventDate(eventData.startDate);
            const updateEnd = normalizeEventDate(eventData.endDate);
            if (updateStart) updateData.startDate = updateStart;
            if (updateEnd) updateData.endDate = updateEnd;
            if (eventData.datesConfirmed !== undefined) {
              updateData.datesConfirmed = eventData.datesConfirmed;
            }
            // Update commercial vendors allowed if provided
            if (eventData.commercialVendorsAllowed !== undefined) {
              updateData.commercialVendorsAllowed = eventData.commercialVendorsAllowed;
            }
            await db.update(events).set(updateData).where(eq(events.id, existing[0].id));
            await recomputeEventCompleteness(db, existing[0].id);
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
            .where(eq(events.slug, unsafeSlug(slugSuffix > 0 ? `${slug}-${slugSuffix}` : slug)))
            .limit(1);
          if (existingSlug.length === 0) break;
          slugSuffix++;
        }
        if (slugSuffix > 0) {
          slug = appendSlugSegment(slug, slugSuffix);
        }

        // Insert the event
        // Use website for ticketUrl (Event Website button), fall back to sourceUrl
        // Description: leave null when the scraper didn't extract one — the
        // round-2 meta-description fallback chain (venue/category-derived)
        // takes over in that case. Previously we wrote `${name} - imported
        // from ${source}` which polluted SEO metadata across 43 events.
        const decodedNewDescription = eventData.description
          ? sanitizeScrapedDescription(eventData.description)
          : null;

        // Pre-ingest date-quality gates. Bulk-import is Tier 2 by default
        // (named scrapers), but the URL inside eventData.sourceUrl may
        // resolve to a Tier 3 aggregator host — evaluateGates handles
        // either case. Failures land in PENDING_REVIEW with gate_flags
        // populated so admins can triage from the recommendations panel.
        // A3 (Dev backlog 2026-06-05): route through normalizeEventDate so
        // bare YYYY-MM-DD lands at noon UTC (canonical anchor). Normalize
        // once here and reuse below for both the gate input and the events
        // INSERT so the two stay in lockstep.
        const normalizedStart = normalizeEventDate(eventData.startDate);
        const normalizedEnd = normalizeEventDate(eventData.endDate);

        const gateInput = {
          name: decodedNewEventName,
          sourceUrl: eventData.sourceUrl ?? null,
          sourceName: eventData.sourceName ?? null,
          startDate: normalizedStart,
          endDate: normalizedEnd,
          applicationDeadline: null,
          description: decodedNewDescription,
        };
        const gateResult = evaluateGates(gateInput);
        const finalStatus = gateResult.route === "PENDING_REVIEW" ? "PENDING" : "APPROVED";
        const gateFlagsJson =
          gateResult.reasons.length > 0 ? JSON.stringify(gateResult.reasons) : null;

        // OPE-627 — report-only duplicate check. Writes the flag; merges nothing.
        // This is the `aggregator_import` path, which the ticket's list of five
        // intake paths did not name but which produced one side of the Logging
        // Festival pair.
        const possibleDuplicateOf = await detectPossibleDuplicate(db, {
          venueId: eventVenueId,
          startDate: normalizedStart,
          endDate: normalizedEnd,
          name: decodedNewEventName,
          promoterId,
        });
        const newEventId = crypto.randomUUID();
        await db.insert(events).values({
          id: newEventId,
          possibleDuplicateOf,
          name: decodedNewEventName,
          slug,
          description: decodedNewDescription,
          promoterId,
          venueId: eventVenueId,
          startDate: normalizedStart,
          endDate: normalizedEnd,
          // OPE-433 — having a date is not the same as having confirmed it.
          //
          // This line derived confirmation from whether a startDate had been
          // parsed at all, so every scraped row that got a date asserted the
          // date was confirmed.
          // That is the mechanism behind the headline number: of 1,373 live
          // events claiming `dates_confirmed`, 1,245 have no citation — and the
          // two lanes fed by this importer are the worst offenders
          // (aggregator_import 280/284, direct_scrape 401/420).
          //
          // It is also why flipping the DDL default would have changed nothing
          // here: this lane never relied on the default, it stated `true`
          // outright.
          //
          // Now: unconfirmed unless the caller explicitly says otherwise. The
          // caller is the only party that can know whether a human or an
          // organizer stood behind the date. `annual_rollover` and the vendor
          // tool already hardcode `false` and are the reference behaviour
          // (rollover: 121 events, exactly 1 claiming confirmation).
          datesConfirmed: eventData.datesConfirmed ?? false,
          categories: JSON.stringify(["Fair", "Festival"]),
          tags: JSON.stringify(["imported", eventData.sourceName]),
          ticketUrl: gateUrlForField(
            eventData.website || eventData.ticketUrl || eventData.sourceUrl,
            "ticket",
            urlClassifications
          ),
          imageUrl: eventData.imageUrl,
          status: finalStatus,
          gateFlags: gateFlagsJson,
          sourceName: eventData.sourceName,
          // Bulk-import is the direct_scrape path — sourceName is a scraper
          // identifier (e.g. "mainefairs.net") and sourceUrl is the
          // event-detail URL. classifier handles both.
          sourceDomain: classifySource(eventData.sourceName, eventData.sourceUrl).sourceDomain,
          ingestionMethod:
            classifySource(eventData.sourceName, eventData.sourceUrl).ingestionMethod ??
            "direct_scrape",
          sourceUrl: eventData.sourceUrl,
          sourceId: eventData.sourceId,
          syncEnabled: true,
          lastSyncedAt: new Date(),
          commercialVendorsAllowed: eventData.commercialVendorsAllowed ?? true,
        });

        // Persist per-day open/close hours when the scraper extracted them
        // from the source page. The scraper produces "HH:MM" wall-clock-at-
        // venue strings (no timezone embedded); conversion to UTC happens at
        // render time via parseWallClockInVenueZone. Batched in 11-row
        // chunks — event_days has 9 storage columns; 9 × 11 = 99, just under
        // D1's 100-bound-parameter cap. Mirrors the url-import pattern in
        // src/app/api/admin/import-url/route.ts.
        if (eventData.eventDays && eventData.eventDays.length > 0) {
          const dayRows = eventData.eventDays.map((d) => ({
            id: crypto.randomUUID(),
            eventId: newEventId,
            date: d.date,
            openTime: d.openTime,
            closeTime: d.closeTime,
            notes: d.notes ?? null,
            closed: false,
            vendorOnly: false,
          }));
          const CHUNK = 11;
          for (let i = 0; i < dayRows.length; i += CHUNK) {
            await db.insert(eventDays).values(dayRows.slice(i, i + CHUNK));
          }
          // OPE-433 scope 5 — importer-created day rows. These are the ones
          // most likely to carry hours nobody published, so which importer
          // wrote them is the first question anyone asks.
          for (const r of dayRows) {
            await recordMutation(db, {
              entityType: "event_day",
              entityId: r.id,
              verb: "create",
              actor: "admin-import",
              after: { date: r.date, openTime: r.openTime, closeTime: r.closeTime },
              note: `scraper import on event ${newEventId}`,
            });
          }
        }

        await recomputeEventCompleteness(db, newEventId);

        await logEnrichment(db, {
          targetType: "event",
          targetId: newEventId,
          source: "scraper",
          status: "success",
          notes: `bulk import from ${eventData.sourceName ?? "unknown"}`,
        });

        results.imported++;
        results.importedEvents.push({
          id: newEventId,
          name: decodedNewEventName,
          slug,
        });
      } catch (error) {
        results.errors.push(
          `Failed to import ${event.name}: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    }

    // IndexNow: bulk import inserts events directly as APPROVED, bypassing
    // the PATCH-based hooks. Batch-ping all imported event URLs and any
    // newly-created venue URLs in two POSTs (max 10k URLs each).
    {
      const cfEnv = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
      if (results.importedEvents.length > 0) {
        const eventUrls = results.importedEvents.map((e) => indexNowUrlFor("events", e.slug));
        await pingIndexNow(db, eventUrls, cfEnv, "event-create");
      }
      if (newVenueSlugsForIndexNow.length > 0) {
        const venueUrls = newVenueSlugsForIndexNow.map((s) => indexNowUrlFor("venues", s));
        await pingIndexNow(db, venueUrls, cfEnv, "venue-create");
      }
    }

    return NextResponse.json(results);
  } catch (error) {
    await logError(db, {
      message: "Error importing events",
      error,
      source: "api/admin/import",
      request,
    });
    return NextResponse.json({ error: "Failed to import events" }, { status: 500 });
  }
});

// PATCH - Sync existing events from their sources
export const PATCH = withAuth({ role: "ADMIN" }, async ({ request, db }) => {
  try {
    // Get all events with sync enabled
    const syncableEvents = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.syncEnabled, true)
          // sourceName is not null - we use a simple check
        )
      );

    // Filter to only events that have a source
    const eventsToSync = syncableEvents.filter((e) => e.sourceName && e.sourceUrl);

    const results = {
      synced: 0,
      unchanged: 0,
      // OPE-483 — "we chose not to try" is not the same outcome as "we tried and
      // nothing changed", and folding both into `unchanged` is how a whole source
      // going dead reads as a clean run. mainefairs.net sat at
      // last_synced_at == created_at for seven months across 20 events, and no
      // counter here would have shown it.
      skippedUnknownSource: 0,
      skippedRetiredSource: [] as string[],
      errors: [] as string[],
    };

    for (const event of eventsToSync) {
      try {
        if (!event.sourceUrl) continue;

        // A source we retired reports itself; an unrecognised one is counted
        // separately from a real no-change. See `results` above.
        const retired = getScraperRetirement(event.sourceName);
        if (retired) {
          const note = `${event.sourceName}: retired ${retired.since} — ${retired.reason}`;
          if (!results.skippedRetiredSource.includes(note)) {
            results.skippedRetiredSource.push(note);
          }
          continue;
        }
        const detailsScraper = getDetailsScraper(event.sourceName);
        if (!detailsScraper) {
          results.skippedUnknownSource++;
          continue;
        }
        const details = await detailsScraper(event.sourceUrl);

        // Update if we got new details
        if (
          details.description ||
          details.startDate ||
          details.endDate ||
          details.imageUrl ||
          details.website
        ) {
          const updates: Record<string, unknown> = {
            lastSyncedAt: new Date(),
            updatedAt: new Date(),
          };

          // K22 — sanitize at the persistence boundary so ANY source's
          // details scraper (not just mainemade) lands a decoded, de-truncated
          // description. Idempotent with the scraper-level sanitize.
          const cleanDetailsDescription = sanitizeScrapedDescription(details.description);
          if (cleanDetailsDescription && cleanDetailsDescription !== event.description) {
            updates.description = cleanDetailsDescription;
          }
          if (
            details.startDate &&
            (!event.startDate ||
              details.startDate.getTime() !== new Date(event.startDate).getTime())
          ) {
            updates.startDate = details.startDate;
          }
          if (
            details.endDate &&
            (!event.endDate || details.endDate.getTime() !== new Date(event.endDate).getTime())
          ) {
            updates.endDate = details.endDate;
          }
          if (details.imageUrl && details.imageUrl !== event.imageUrl) {
            updates.imageUrl = details.imageUrl;
          }
          if (details.website && details.website !== event.ticketUrl) {
            updates.ticketUrl = details.website;
          }

          if (Object.keys(updates).length > 2) {
            // More than just timestamps
            await db.update(events).set(updates).where(eq(events.id, event.id));
            await recomputeEventCompleteness(db, event.id);
            results.synced++;
          } else {
            // Just update the sync timestamp
            await db
              .update(events)
              .set({
                lastSyncedAt: new Date(),
              })
              .where(eq(events.id, event.id));
            results.unchanged++;
          }
        } else {
          results.unchanged++;
        }
      } catch (error) {
        results.errors.push(
          `Failed to sync ${event.name}: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    }

    return NextResponse.json(results);
  } catch (error) {
    await logError(db, {
      message: "Error syncing events",
      error,
      source: "api/admin/import",
      request,
    });
    return NextResponse.json({ error: "Failed to sync events" }, { status: 500 });
  }
});
