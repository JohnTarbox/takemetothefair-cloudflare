export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { events, venues, promoters, eventSchemaOrg } from "@/lib/db/schema";
import { parseJsonLd } from "@/lib/schema-org";
import { eq } from "drizzle-orm";
import { createSlug, dollarsToCents, appendSlugSegment, unsafeSlug } from "@/lib/utils";
import { resolveUniqueEventSlug, insertEventDaysBatched } from "@/lib/events/insert-helpers";
import type { VenueOption, ExtractedEventData } from "@/lib/url-import/types";
import { inferCategoriesFromName } from "@/lib/url-import/infer-categories";
import { logError } from "@/lib/logger";
import { recomputeEventCompleteness } from "@/lib/completeness";
import { logEnrichment } from "@/lib/enrichment-log";
import { parseDateOnly } from "@/lib/datetime";
import { normalizeEventDate } from "@/lib/event-dates";
import { areDatesContiguous } from "@takemetothefair/utils";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { geocodeAddress } from "@/lib/google-maps";
import { loadClassifications, gateUrlForField } from "@/lib/url-classification";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";
import { evaluateGates } from "@/lib/event-date-gates";
import { classifySource } from "@/lib/source-classification";

interface ImportRequest {
  event: ExtractedEventData & {
    datesConfirmed?: boolean;
  };
  venueOption: VenueOption;
  promoterId: string;
  sourceUrl?: string;
  jsonLd?: Record<string, unknown>; // JSON-LD from the source page for schema.org storage
}

export const POST = withAuth({ role: "ADMIN" }, async ({ request, db }) => {
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
          .where(
            eq(venues.slug, unsafeSlug(slugSuffix > 0 ? `${venueSlug}-${slugSuffix}` : venueSlug))
          )
          .limit(1);
        if (existingSlug.length === 0) break;
        slugSuffix++;
      }
      if (slugSuffix > 0) {
        finalVenueSlug = appendSlugSegment(venueSlug, slugSuffix);
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

    // Generate event slug. WS2a — shared prefix-range resolver (was a
    // per-candidate while-loop; now `base-2` first on collision, not `base-1`).
    const eventSlug = createSlug(event.name);
    const finalEventSlug = await resolveUniqueEventSlug(db, eventSlug);

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
      // A3 (Dev backlog 2026-06-05): route through normalizeEventDate so
      // a bare YYYY-MM-DD lands at noon UTC (canonical anchor), matching
      // every other ingest path.
      startDate = normalizeEventDate(event.startDate);
      endDate = normalizeEventDate(event.endDate);
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

    // Pre-ingest gate evaluation. URL-import is the path that produced the
    // analyst's 2026-05-16 failures (TEC aggregator hosts, application
    // deadline as start_date, stale prior-year dates). evaluateGates routes
    // suspicious rows to PENDING_REVIEW with reasons recorded in gate_flags.
    const gateResult = evaluateGates({
      name: event.name,
      sourceUrl: sourceUrl ?? null,
      sourceName: "url-import",
      startDate,
      endDate,
      // ExtractedEventData has no applicationDeadline field today — gate
      // skips the start_equals_deadline check on URL-import for that reason.
      // If the URL extractor learns to pull applicationDeadline, pass it here.
      applicationDeadline: null,
      description: event.description,
    });
    const finalStatus = gateResult.route === "PENDING_REVIEW" ? "PENDING" : "APPROVED";
    const gateFlagsJson = gateResult.reasons.length > 0 ? JSON.stringify(gateResult.reasons) : null;

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
      // OPE-47 (2026-07): a specificDates list is discontinuous ONLY when the
      // dates aren't a gap-free daily run — a cadence-expanded weekly market
      // (every Saturday) → true; a contiguous multi-day fair the AI happened
      // to enumerate day-by-day → false, so it keeps its "Daily:" label. Same
      // `!areDatesContiguous` rule the display uses, so flag and label agree.
      discontinuousDates: hasSpecificDates ? !areDatesContiguous(event.specificDates!) : false,
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
      status: finalStatus,
      gateFlags: gateFlagsJson,
      sourceName: "url-import",
      // URL-import is admin-driven paste; classifier picks up the actual
      // origin domain from sourceUrl (so the dashboard groups by real
      // publisher) and labels the method as admin_manual.
      sourceDomain: classifySource("url-import", sourceUrl).sourceDomain,
      ingestionMethod: classifySource("url-import", sourceUrl).ingestionMethod ?? "admin_manual",
      sourceUrl: sourceUrl || null,
      sourceId: sourceUrl ? createSlug(sourceUrl) : newEventId,
      syncEnabled: false,
      lastSyncedAt: new Date(),
    });

    await recomputeEventCompleteness(db, newEventId);

    await logEnrichment(db, {
      targetType: "event",
      targetId: newEventId,
      source: "ai_workers",
      status: "success",
      notes: sourceUrl ? `URL import: ${sourceUrl}` : "URL import",
    });

    // Insert eventDays rows. D1 caps each statement at 100 bound parameters;
    // event_days rows pass up to 9 columns (8 explicit + the $defaultFn
    // createdAt), so chunks are capped at 11 rows (11 × 9 = 99). See the
    // admin event-edit PATCH handler for the full incident note.
    // DQ4 (2026-06-08): both branches below used to default to "10:00"/
    // "18:00" or echo startTime into closeTime when the AI extractor
    // didn't surface times. Now we pass through null and flag the parent
    // event for operator triage. anyHoursUnknown is computed alongside
    // the insert so the events UPDATE happens before the cascade-OK row
    // commits.
    let anyHoursUnknown = false;
    if (hasSpecificDates) {
      // Discontinuous: create eventDays from specificDates
      const days = event.specificDates!.map((dateStr, idx) => {
        const openTime = event.startTime || null;
        const closeTime = event.endTime || null;
        if (openTime == null || closeTime == null) anyHoursUnknown = true;
        return {
          id: crypto.randomUUID(),
          eventId: newEventId,
          date: dateStr,
          openTime,
          closeTime,
          notes: idx === 0 && event.hoursNotes ? event.hoursNotes : null,
          closed: false,
        };
      });

      // WS2a — shared D1-safe batched insert (was an inline BATCH_SIZE=11 loop).
      await insertEventDaysBatched(db, newEventId, days);
    } else if (startDate) {
      // Contiguous: generate one row per day in the date range. DQ4 — the
      // outer guard used to require `event.startTime && startDate`; now
      // we always materialize event_days when we have a date span and
      // fall back to null hours when the extractor didn't get times.
      // Same flag-for-review wiring as the discontinuous branch above.
      const rangeEnd = endDate || startDate;
      const days: Array<{
        id: string;
        eventId: string;
        date: string;
        openTime: string | null;
        closeTime: string | null;
        notes: string | null;
        closed: boolean;
      }> = [];

      const openTime = event.startTime || null;
      const closeTime = event.endTime || openTime; // mirror prior shape when only open is known
      if (openTime == null || closeTime == null) anyHoursUnknown = true;

      const current = new Date(startDate);
      const last = new Date(rangeEnd);
      let isFirst = true;
      while (current <= last) {
        const dateStr = current.toISOString().substring(0, 10);
        days.push({
          id: crypto.randomUUID(),
          eventId: newEventId,
          date: dateStr,
          openTime,
          closeTime,
          notes: isFirst && event.hoursNotes ? event.hoursNotes : null,
          closed: false,
        });
        isFirst = false;
        current.setDate(current.getDate() + 1);
      }

      // WS2a — shared D1-safe batched insert (was an inline BATCH_SIZE=11 loop).
      await insertEventDaysBatched(db, newEventId, days);
    }
    if (anyHoursUnknown) {
      // DQ4: flag the parent event so the operator triage queue
      // (/admin/events?flagged=1) surfaces it for human follow-up.
      await db.update(events).set({ flaggedForReview: 1 }).where(eq(events.id, newEventId));
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
});
