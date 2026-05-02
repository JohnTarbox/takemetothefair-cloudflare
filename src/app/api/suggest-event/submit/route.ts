import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { events, promoters, eventSchemaOrg, eventDays } from "@/lib/db/schema";
import { parseJsonLd } from "@/lib/schema-org";
import { eq } from "drizzle-orm";
import { createSlug, computePublicDates, decodeHtmlEntities } from "@/lib/utils";
import { logError } from "@/lib/logger";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { verifyTurnstileToken, getTurnstileErrorMessage } from "@/lib/turnstile";
import { auth } from "@/lib/auth";
import { inferCategoriesFromName } from "@/lib/url-import/infer-categories";
import { loadClassifications, gateUrlForField } from "@/lib/url-classification";
import { PUBLIC_EVENT_STATUSES } from "@/lib/constants";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";

const PUBLIC_EVENT_SET = new Set<string>(PUBLIC_EVENT_STATUSES);

export const runtime = "edge";

// The stable ID for the Community Suggestions promoter
const COMMUNITY_PROMOTER_ID = "system-community-suggestions";

const eventDaySchema = z.object({
  date: z.string(), // YYYY-MM-DD
  openTime: z.string(), // HH:MM
  closeTime: z.string(), // HH:MM
  notes: z.string().optional(),
  closed: z.boolean().optional(),
  vendorOnly: z.boolean().optional(),
});

const submitEventSchema = z.object({
  name: z.string().min(1, "Event name is required").transform(decodeHtmlEntities),
  description: z.string().transform(decodeHtmlEntities).nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  startTime: z.string().nullable().optional(), // HH:MM format
  endTime: z.string().nullable().optional(), // HH:MM format
  hoursVaryByDay: z.boolean().optional(),
  hoursNotes: z.string().transform(decodeHtmlEntities).nullable().optional(),
  venueId: z.string().uuid().nullable().optional(), // Link to existing venue if confirmed
  venueName: z.string().transform(decodeHtmlEntities).nullable().optional(),
  venueAddress: z.string().nullable().optional(),
  venueCity: z.string().nullable().optional(),
  venueState: z.string().nullable().optional(),
  ticketUrl: z.string().nullable().optional(),
  ticketPriceMin: z.number().nullable().optional(),
  ticketPriceMax: z.number().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  categories: z.array(z.string()).nullable().optional(),
  // Vendor decision-support fields
  vendorFeeMin: z.number().nullable().optional(),
  vendorFeeMax: z.number().nullable().optional(),
  vendorFeeNotes: z.string().transform(decodeHtmlEntities).nullable().optional(),
  indoorOutdoor: z.enum(["INDOOR", "OUTDOOR", "MIXED"]).nullable().optional(),
  estimatedAttendance: z.number().int().nullable().optional(),
  eventScale: z.enum(["SMALL", "MEDIUM", "LARGE", "MAJOR"]).nullable().optional(),
  applicationUrl: z.string().nullable().optional(),
  walkInsAllowed: z.boolean().nullable().optional(),
  sourceUrl: z.string().url().optional(),
  suggesterEmail: z.string().email().optional().or(z.literal("")),
  jsonLd: z.record(z.string(), z.unknown()).optional(),
  turnstileToken: z.string().optional(), // Turnstile verification token
  eventDays: z.array(eventDaySchema).optional(), // Per-day schedule
  submittedByUserId: z.string().optional(), // User who submitted (auto-filled for authenticated users)
  source: z.enum(["community", "vendor"]).optional(), // Submission source
});

export async function POST(request: NextRequest) {
  // Rate limiting check
  const rateLimitResult = await checkRateLimit(request, "suggest-event-submit");
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
  }

  const db = getCloudflareDb();

  try {
    const body = await request.json();
    const validation = submitEventSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: validation.error.issues[0]?.message || "Validation failed" },
        { status: 400 }
      );
    }

    const data = validation.data;

    // Check auth for authenticated submissions
    const session = await auth();
    if (session?.user?.id && !data.submittedByUserId) {
      data.submittedByUserId = session.user.id;
    }

    // Verify Turnstile token for anonymous users
    if (!rateLimitResult.isAuthenticated) {
      const turnstileResult = await verifyTurnstileToken(data.turnstileToken || "", request);
      if (!turnstileResult.success) {
        return NextResponse.json(
          {
            success: false,
            error: getTurnstileErrorMessage(turnstileResult.errorCodes),
          },
          { status: 400 }
        );
      }
    }

    // Verify the community promoter exists
    const promoter = await db
      .select()
      .from(promoters)
      .where(eq(promoters.id, COMMUNITY_PROMOTER_ID))
      .limit(1);

    if (promoter.length === 0) {
      // Create it if it doesn't exist (for non-seeded databases)
      await db.insert(promoters).values({
        id: COMMUNITY_PROMOTER_ID,
        userId: null,
        companyName: "Community Suggestions",
        slug: "community-suggestions",
        description: "Events suggested by the community. These events are pending admin review.",
        verified: false,
      });
    }

    // Generate event slug
    const eventSlug = createSlug(data.name);
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

    // Parse dates
    let startDate: Date | null = null;
    let endDate: Date | null = null;

    if (data.startDate) {
      startDate = new Date(data.startDate);
      if (isNaN(startDate.getTime())) startDate = null;
    }

    if (data.endDate) {
      endDate = new Date(data.endDate);
      if (isNaN(endDate.getTime())) endDate = null;
    }

    // Build description with location info if provided
    let description = data.description || `${data.name} - suggested by the community`;
    if (data.venueName || data.venueCity) {
      const locationParts: string[] = [];
      if (data.venueName) locationParts.push(data.venueName);
      if (data.venueAddress) locationParts.push(data.venueAddress);
      if (data.venueCity) locationParts.push(data.venueCity);
      if (data.venueState) locationParts.push(data.venueState);
      if (locationParts.length > 0 && !description.includes(locationParts[0])) {
        description += `\n\nLocation: ${locationParts.join(", ")}`;
      }
    }

    // Determine status: vendor submissions get TENTATIVE (publicly visible), others get PENDING
    const eventStatus = data.source === "vendor" ? "TENTATIVE" : "PENDING";
    const tagList =
      data.source === "vendor"
        ? ["community-suggestion", "vendor-submission"]
        : ["community-suggestion"];

    // Gate URLs against the domain classification table — community/vendor
    // submissions can include arbitrary URLs, so we filter aggregator domains
    // out of ticket_url and application_url before insert.
    const urlClassifications = await loadClassifications(db);
    const gatedTicketUrl = gateUrlForField(
      data.ticketUrl || data.sourceUrl || null,
      "ticket",
      urlClassifications
    );
    const gatedApplicationUrl = gateUrlForField(
      data.applicationUrl ?? null,
      "application",
      urlClassifications
    );

    // Create the event
    const newEventId = crypto.randomUUID();
    await db.insert(events).values({
      id: newEventId,
      name: data.name,
      slug: finalEventSlug,
      description,
      promoterId: COMMUNITY_PROMOTER_ID,
      venueId: data.venueId || null, // Link to confirmed venue if provided
      startDate,
      endDate,
      publicStartDate:
        data.eventDays && data.eventDays.length > 0
          ? computePublicDates(data.eventDays).publicStartDate
          : startDate,
      publicEndDate:
        data.eventDays && data.eventDays.length > 0
          ? computePublicDates(data.eventDays).publicEndDate
          : endDate,
      datesConfirmed: startDate !== null,
      categories: JSON.stringify(
        Array.isArray(data.categories) && data.categories.length > 0
          ? data.categories
          : (inferCategoriesFromName(data.name) ?? ["Event"])
      ),
      tags: JSON.stringify(tagList),
      ticketUrl: gatedTicketUrl,
      ticketPriceMin: data.ticketPriceMin ?? null,
      ticketPriceMax: data.ticketPriceMax ?? null,
      imageUrl: data.imageUrl || null,
      status: eventStatus,
      sourceName: data.source === "vendor" ? "vendor-submission" : "community-suggestion",
      sourceUrl: data.sourceUrl || null,
      sourceId: data.sourceUrl ? createSlug(data.sourceUrl) : newEventId,
      syncEnabled: false,
      lastSyncedAt: new Date(),
      suggesterEmail: data.suggesterEmail || null,
      submittedByUserId: data.submittedByUserId || null,
      vendorFeeMin: data.vendorFeeMin ?? null,
      vendorFeeMax: data.vendorFeeMax ?? null,
      vendorFeeNotes: data.vendorFeeNotes ?? null,
      indoorOutdoor: data.indoorOutdoor ?? null,
      estimatedAttendance: data.estimatedAttendance ?? null,
      eventScale: data.eventScale ?? null,
      applicationUrl: gatedApplicationUrl,
      walkInsAllowed: data.walkInsAllowed ?? null,
    });

    // Insert event days if provided
    if (data.eventDays && data.eventDays.length > 0) {
      await db.insert(eventDays).values(
        data.eventDays.map((day) => ({
          id: crypto.randomUUID(),
          eventId: newEventId,
          date: day.date,
          openTime: day.openTime,
          closeTime: day.closeTime,
          notes: day.notes || null,
          closed: day.closed || false,
          vendorOnly: day.vendorOnly || false,
        }))
      );
    }

    // Store schema.org data if JSON-LD was provided
    if (data.jsonLd) {
      try {
        const parseResult = parseJsonLd(data.jsonLd);
        const now = new Date();
        const ticketUrl = data.ticketUrl || data.sourceUrl || null;

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
          schemaPriceMin: parseResult.data?.priceMin || null,
          schemaPriceMax: parseResult.data?.priceMax || null,
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
          message: "Failed to store schema.org data during suggest-event submit",
          error: schemaError,
          source: "suggest-event-submit",
          request,
        });
      }
    }

    // IndexNow: vendor submissions land as TENTATIVE (publicly visible) and
    // bypass the PATCH-based hooks. Ping for those; PENDING community
    // suggestions stay non-public until an admin promotes them.
    if (PUBLIC_EVENT_SET.has(eventStatus)) {
      const cfEnv = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
      await pingIndexNow(db, indexNowUrlFor("events", finalEventSlug), cfEnv, "event-create");
    }

    return NextResponse.json({
      success: true,
      event: {
        id: newEventId,
        slug: finalEventSlug,
        name: data.name,
      },
    });
  } catch (error) {
    await logError(db, {
      message: "Error submitting event suggestion",
      error,
      source: "api/suggest-event/submit",
      request,
    });
    return NextResponse.json(
      { success: false, error: "Failed to submit event suggestion. Please try again." },
      { status: 500 }
    );
  }
}
