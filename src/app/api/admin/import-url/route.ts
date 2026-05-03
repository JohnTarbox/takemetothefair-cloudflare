import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, eventDays, venues, promoters, eventSchemaOrg } from "@/lib/db/schema";
import { parseJsonLd } from "@/lib/schema-org";
import { eq } from "drizzle-orm";
import { createSlug, dollarsToCents } from "@/lib/utils";
import type { VenueOption, ExtractedEventData } from "@/lib/url-import/types";
import { inferCategoriesFromName } from "@/lib/url-import/infer-categories";
import { logError } from "@/lib/logger";
import { parseDateOnly } from "@/lib/datetime";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { geocodeAddress } from "@/lib/google-maps";
import { loadClassifications, gateUrlForField } from "@/lib/url-classification";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";

export const runtime = "edge";

interface ImportRequest {
  event: ExtractedEventData & {
    datesConfirmed?: boolean;
  };
  venueOption: VenueOption;
  promoterId: string;
  sourceUrl?: string;
  jsonLd?: Record<string, unknown>; // JSON-LD from the source page for schema.org storage
}

export async function POST(request: NextRequest) {
  const db = getCloudflareDb();
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as ImportRequest;
    const { event, venueOption, promoterId, sourceUrl, jsonLd } = body;

    // Validate required fields
    if (!event.name) {
      return NextResponse.json(
        { success: false, error: "Event name is required" },
        { status: 400 }
      );
    }

    if (!promoterId) {
      return NextResponse.json({ success: false, error: "Promoter is required" }, { status: 400 });
    }

    // Verify promoter exists
    const promoter = await db.select().from(promoters).where(eq(promoters.id, promoterId)).limit(1);

    if (promoter.length === 0) {
      return NextResponse.json({ success: false, error: "Promoter not found" }, { status: 400 });
    }

    // Handle venue
    let venueId: string | null = null;
    let newVenueSlug: string | null = null;

    if (venueOption.type === "existing") {
      // Verify venue exists
      const existingVenue = await db
        .select()
        .from(venues)
        .where(eq(venues.id, venueOption.id))
        .limit(1);

      if (existingVenue.length === 0) {
        return NextResponse.json({ success: false, error: "Venue not found" }, { status: 400 });
      }
      venueId = venueOption.id;
    } else if (venueOption.type === "new") {
      // Create new venue
      const venueSlug = createSlug(venueOption.name);

      // Check if venue slug already exists
      let finalVenueSlug = venueSlug;
      let slugSuffix = 0;
      while (true) {
        const existingSlug = await db
          .select()
          .from(venues)
          .where(eq(venues.slug, slugSuffix > 0 ? `${venueSlug}-${slugSuffix}` : venueSlug))
          .limit(1);
        if (existingSlug.length === 0) break;
        slugSuffix++;
      }
      if (slugSuffix > 0) {
        finalVenueSlug = `${venueSlug}-${slugSuffix}`;
      }

      const newVenueId = crypto.randomUUID();
      await db.insert(venues).values({
        id: newVenueId,
        name: venueOption.name,
        slug: finalVenueSlug,
        address: venueOption.address || "",
        city: venueOption.city || "",
        state: venueOption.state || "",
        zip: "",
        status: "ACTIVE",
      });
      venueId = newVenueId;
      newVenueSlug = finalVenueSlug;

      // Auto-geocode the new venue
      try {
        const cfEnv = getCloudflareEnv();
        const geo = await geocodeAddress(
          venueOption.address || "",
          venueOption.city || "",
          venueOption.state || "",
          undefined,
          cfEnv.GOOGLE_MAPS_API_KEY
        );
        if (geo) {
          const geoUpdates: Record<string, unknown> = {
            latitude: geo.lat,
            longitude: geo.lng,
            updatedAt: new Date(),
          };
          if (geo.zip) geoUpdates.zip = geo.zip;
          await db.update(venues).set(geoUpdates).where(eq(venues.id, newVenueId));
        }
      } catch {
        // Non-blocking: venue still created without coordinates
      }
    }
    // For type === "none", venueId remains null

    // Generate event slug
    const eventSlug = createSlug(event.name);
    let finalEventSlug = eventSlug;
    let slugSuffix = 0;
    while (true) {
      const existingSlug = await db
        .select()
        .from(events)
        .where(eq(events.slug, slugSuffix > 0 ? `${eventSlug}-${slugSuffix}` : eventSlug))
        .limit(1);
      if (existingSlug.length === 0) break;
      slugSuffix++;
    }
    if (slugSuffix > 0) {
      finalEventSlug = `${eventSlug}-${slugSuffix}`;
    }

    // Determine if this is a discontinuous (specific dates) event
    const hasSpecificDates = event.specificDates && event.specificDates.length > 0;

    // Parse dates
    let startDate: Date | null = null;
    let endDate: Date | null = null;

    if (hasSpecificDates) {
      // Auto-compute from specificDates
      const sorted = [...event.specificDates!].sort();
      startDate = parseDateOnly(sorted[0]);
      endDate = parseDateOnly(sorted[sorted.length - 1]);
    } else {
      if (event.startDate) {
        startDate = new Date(event.startDate);
        if (isNaN(startDate.getTime())) startDate = null;
      }
      if (event.endDate) {
        endDate = new Date(event.endDate);
        if (isNaN(endDate.getTime())) endDate = null;
      }
    }

    // Resolve state_code: explicit from extractor wins, then venueState hint,
    // then look up the state on a newly-attached venue if we have one.
    let resolvedStateCode = event.stateCode || event.venueState || null;
    if (!resolvedStateCode && venueId) {
      const venueRow = await db
        .select({ state: venues.state })
        .from(venues)
        .where(eq(venues.id, venueId))
        .limit(1);
      resolvedStateCode = venueRow[0]?.state ?? null;
    }

    // Gate the ticket URL against the domain classification table — same lookup
    // is reused below for the schema.org audit row.
    const urlClassifications = await loadClassifications(db);
    const gatedTicketUrl = gateUrlForField(
      event.ticketUrl || sourceUrl || null,
      "ticket",
      urlClassifications
    );

    // Create the event
    const newEventId = crypto.randomUUID();
    await db.insert(events).values({
      id: newEventId,
      name: event.name,
      slug: finalEventSlug,
      // Leave null when the URL extractor didn't pull a description; the
      // meta-description fallback chain handles SEO. Previously this wrote
      // "{name} - imported from URL" which polluted descriptions.
      description: event.description || null,
      promoterId,
      venueId,
      stateCode: resolvedStateCode,
      isStatewide: event.isStatewide === true,
      startDate,
      endDate,
      publicStartDate: startDate,
      publicEndDate: endDate,
      datesConfirmed: event.datesConfirmed ?? startDate !== null,
      discontinuousDates: hasSpecificDates || false,
      categories: JSON.stringify(
        Array.isArray(event.categories) && event.categories.length > 0
          ? event.categories
          : (inferCategoriesFromName(event.name) ?? ["Event"])
      ),
      tags: JSON.stringify(["imported", "url-import"]),
      ticketUrl: gatedTicketUrl,
      ticketPriceMinCents: dollarsToCents(event.ticketPriceMin),
      ticketPriceMaxCents: dollarsToCents(event.ticketPriceMax),
      imageUrl: event.imageUrl,
      status: "APPROVED",
      sourceName: "url-import",
      sourceUrl: sourceUrl || null,
      sourceId: sourceUrl ? createSlug(sourceUrl) : newEventId,
      syncEnabled: false,
      lastSyncedAt: new Date(),
    });

    // Insert eventDays rows
    if (hasSpecificDates) {
      // Discontinuous: create eventDays from specificDates
      const days = event.specificDates!.map((dateStr, idx) => ({
        id: crypto.randomUUID(),
        eventId: newEventId,
        date: dateStr,
        openTime: event.startTime || "10:00",
        closeTime: event.endTime || "18:00",
        notes: idx === 0 && event.hoursNotes ? event.hoursNotes : null,
        closed: false,
      }));

      const BATCH_SIZE = 100;
      for (let i = 0; i < days.length; i += BATCH_SIZE) {
        const batch = days.slice(i, i + BATCH_SIZE);
        await db.insert(eventDays).values(batch);
      }
    } else if (event.startTime && startDate) {
      // Contiguous: generate one row per day in the date range
      const rangeEnd = endDate || startDate;
      const days: Array<{
        id: string;
        eventId: string;
        date: string;
        openTime: string;
        closeTime: string;
        notes: string | null;
        closed: boolean;
      }> = [];

      const current = new Date(startDate);
      const last = new Date(rangeEnd);
      let isFirst = true;
      while (current <= last) {
        const dateStr = current.toISOString().substring(0, 10);
        days.push({
          id: crypto.randomUUID(),
          eventId: newEventId,
          date: dateStr,
          openTime: event.startTime,
          closeTime: event.endTime || event.startTime,
          notes: isFirst && event.hoursNotes ? event.hoursNotes : null,
          closed: false,
        });
        isFirst = false;
        current.setDate(current.getDate() + 1);
      }

      // Batch insert to avoid SQLite variable limit (7 vars per row × 100 = 700 < 999)
      const BATCH_SIZE = 100;
      for (let i = 0; i < days.length; i += BATCH_SIZE) {
        const batch = days.slice(i, i + BATCH_SIZE);
        await db.insert(eventDays).values(batch);
      }
    }

    // Store schema.org data if JSON-LD was provided
    if (jsonLd) {
      try {
        const parseResult = parseJsonLd(jsonLd);
        const now = new Date();
        // Use the same gated ticket URL we wrote to events.ticket_url so the
        // schema.org audit row stays consistent with what we actually link to.
        const ticketUrl = gatedTicketUrl;

        await db.insert(eventSchemaOrg).values({
          id: crypto.randomUUID(),
          eventId: newEventId,
          ticketUrl,
          rawJsonLd: parseResult.rawJsonLd,
          schemaName: parseResult.data?.name || null,
          schemaDescription: parseResult.data?.description || null,
          schemaStartDate: parseResult.data?.startDate || null,
          schemaEndDate: parseResult.data?.endDate || null,
          schemaVenueName: parseResult.data?.venueName || null,
          schemaVenueAddress: parseResult.data?.venueAddress || null,
          schemaVenueCity: parseResult.data?.venueCity || null,
          schemaVenueState: parseResult.data?.venueState || null,
          schemaVenueLat: parseResult.data?.venueLat || null,
          schemaVenueLng: parseResult.data?.venueLng || null,
          schemaImageUrl: parseResult.data?.imageUrl || null,
          schemaTicketUrl: parseResult.data?.ticketUrl || null,
          schemaPriceMinCents: dollarsToCents(parseResult.data?.priceMin),
          schemaPriceMaxCents: dollarsToCents(parseResult.data?.priceMax),
          schemaEventStatus: parseResult.data?.eventStatus || null,
          schemaOrganizerName: parseResult.data?.organizerName || null,
          schemaOrganizerUrl: parseResult.data?.organizerUrl || null,
          status: parseResult.status,
          lastFetchedAt: now,
          lastError: parseResult.error || null,
          fetchCount: 1,
          createdAt: now,
          updatedAt: now,
        });
      } catch (schemaError) {
        // Non-blocking: event still created without schema.org data.
        // Routes through logError so the failure surfaces in /admin/logs.
        await logError(db, {
          message: "Failed to store schema.org data during URL import",
          error: schemaError,
          source: "admin-import-url",
          request,
        });
      }
    }

    // IndexNow: this endpoint creates events directly as APPROVED, bypassing
    // the PATCH-based hooks. Ping for the new event (always public on save) and
    // any newly-created venue. Reused/existing venues are skipped — they're
    // already indexed.
    {
      const cfEnv = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
      if (newVenueSlug) {
        await pingIndexNow(db, indexNowUrlFor("venues", newVenueSlug), cfEnv, "venue-create");
      }
      await pingIndexNow(db, indexNowUrlFor("events", finalEventSlug), cfEnv, "event-create");
    }

    return NextResponse.json({
      success: true,
      event: {
        id: newEventId,
        slug: finalEventSlug,
      },
      venueId, // Return venueId for reuse in batch imports
    });
  } catch (error) {
    await logError(db, {
      message: "Error saving event",
      error,
      source: "api/admin/import-url",
      request,
    });
    return NextResponse.json(
      { success: false, error: "Failed to save event. Please try again." },
      { status: 500 }
    );
  }
}
