export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { promoters, events, venues } from "@/lib/db/schema";
import { eventVenueJoinProjection } from "@/lib/db/event-join-projection";
import { eq, desc } from "drizzle-orm";
import { createSlug, computePublicDates, dollarsToCents } from "@/lib/utils";
import { resolveUniqueEventSlug, insertEventDaysBatched } from "@/lib/events/insert-helpers";
import { validateRequestBody, promoterEventCreateSchema } from "@/lib/validations";
import { logError } from "@/lib/logger";
import { parseDateOnly } from "@/lib/datetime";
import { normalizeEventDate } from "@/lib/event-dates";
import { recomputeEventCompleteness } from "@/lib/completeness";

export async function GET(request: NextRequest) {
  const db = getCloudflareDb();
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const promoterResults = await db
      .select()
      .from(promoters)
      .where(eq(promoters.userId, session.user.id))
      .limit(1);

    if (promoterResults.length === 0) {
      return NextResponse.json({ error: "Promoter profile not found" }, { status: 404 });
    }

    const promoter = promoterResults[0];

    // Narrow projection via eventVenueJoinProjection (62 + 7 = 69 cols
    // vs bare 62 + 30 = 92). Consumer only reads venue.name.
    const eventResults = await db
      .select(eventVenueJoinProjection)
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(eq(events.promoterId, promoter.id))
      .orderBy(desc(events.createdAt));

    const eventsList = eventResults.map((r) => ({
      ...r.events,
      venue: r.venue ? { name: r.venue.name } : null,
    }));

    return NextResponse.json(eventsList);
  } catch (error) {
    await logError(db, {
      message: "Failed to fetch events",
      error,
      source: "api/promoter/events",
      request,
    });
    return NextResponse.json({ error: "Failed to fetch events" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const db = getCloudflareDb();
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const promoterResults = await db
      .select()
      .from(promoters)
      .where(eq(promoters.userId, session.user.id))
      .limit(1);

    if (promoterResults.length === 0) {
      return NextResponse.json(
        { error: "Promoter profile not found. Please complete your profile first." },
        { status: 404 }
      );
    }

    const promoter = promoterResults[0];

    const validation = await validateRequestBody(request, promoterEventCreateSchema);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const {
      name,
      description,
      venueId,
      stateCode,
      isStatewide,
      startDate: rawStartDate,
      endDate: rawEndDate,
      discontinuousDates: isDiscontinuous,
      categories,
      tags,
      ticketUrl,
      ticketPriceMin,
      ticketPriceMax,
      imageUrl,
      eventDays: eventDaysInput,
      vendorFeeMin,
      vendorFeeMax,
      vendorFeeNotes,
      indoorOutdoor,
      estimatedAttendance,
      eventScale,
      applicationDeadline,
      applicationUrl,
      applicationInstructions,
      walkInsAllowed,
    } = validation.data;

    // Auto-compute startDate/endDate from eventDays when discontinuous
    let startDate = rawStartDate;
    let endDate = rawEndDate;
    if (isDiscontinuous && eventDaysInput && eventDaysInput.length > 0) {
      const sorted = eventDaysInput.map((d) => d.date).sort();
      startDate = parseDateOnly(sorted[0])?.toISOString() ?? null;
      endDate = parseDateOnly(sorted[sorted.length - 1])?.toISOString() ?? null;
    }

    // Auto-compute public date range (excluding vendor-only days).
    // A3 (Dev backlog 2026-06-05): route through normalizeEventDate so a
    // bare YYYY-MM-DD lands at noon UTC (canonical anchor) rather than
    // the midnight-UTC default that renders as previous-day-EDT.
    const { publicStartDate, publicEndDate } =
      eventDaysInput && eventDaysInput.length > 0
        ? computePublicDates(eventDaysInput)
        : {
            publicStartDate: normalizeEventDate(startDate),
            publicEndDate: normalizeEventDate(endDate),
          };

    const baseSlug = createSlug(name);

    // Handle empty slug (e.g., name with only special characters)
    if (!baseSlug) {
      return NextResponse.json(
        { error: "Event name must contain alphanumeric characters" },
        { status: 400 }
      );
    }

    // WS2a — shared helper (prefix-range query + findUniqueSlug). Was inlined.
    const slug = await resolveUniqueEventSlug(db, baseSlug);

    const eventId = crypto.randomUUID();

    // Derive stateCode from the attached venue when not explicitly provided.
    let resolvedStateCode = stateCode ?? null;
    if (!resolvedStateCode && venueId) {
      const venueRow = await db
        .select({ state: venues.state })
        .from(venues)
        .where(eq(venues.id, venueId))
        .limit(1);
      resolvedStateCode = venueRow[0]?.state ?? null;
    }

    await db.insert(events).values({
      id: eventId,
      name,
      slug,
      description,
      venueId: venueId || null,
      stateCode: resolvedStateCode,
      isStatewide: isStatewide ?? false,
      promoterId: promoter.id,
      startDate: normalizeEventDate(startDate),
      endDate: normalizeEventDate(endDate),
      publicStartDate,
      publicEndDate,
      discontinuousDates: isDiscontinuous || false,
      categories: JSON.stringify(categories || []),
      tags: JSON.stringify(tags || []),
      ticketUrl,
      ticketPriceMinCents: dollarsToCents(ticketPriceMin),
      ticketPriceMaxCents: dollarsToCents(ticketPriceMax),
      imageUrl,
      status: "PENDING",
      vendorFeeMinCents: dollarsToCents(vendorFeeMin),
      vendorFeeMaxCents: dollarsToCents(vendorFeeMax),
      vendorFeeNotes,
      indoorOutdoor,
      estimatedAttendance,
      eventScale,
      applicationDeadline: applicationDeadline ? new Date(applicationDeadline) : null,
      applicationUrl,
      applicationInstructions,
      walkInsAllowed,
    });

    await recomputeEventCompleteness(db, eventId);

    // WS2a — shared D1-safe batched insert. FIX: this path previously inserted
    // ALL days in one statement, blowing D1's bound-parameter limit for events
    // with ≥12 days; the helper chunks at 11.
    await insertEventDaysBatched(db, eventId, eventDaysInput);

    const newEvent = await db.select().from(events).where(eq(events.id, eventId)).limit(1);

    return NextResponse.json(newEvent[0], { status: 201 });
  } catch (error) {
    await logError(db, {
      message: "Failed to create event",
      error,
      source: "api/promoter/events",
      request,
    });
    return NextResponse.json({ error: "Failed to create event" }, { status: 500 });
  }
}
