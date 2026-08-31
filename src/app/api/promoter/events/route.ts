export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { detectPossibleDuplicate } from "@/lib/duplicates/venue-date-collision";
import { auth } from "@/lib/auth";
import { requireVerifiedSession } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { promoters, events, venues } from "@/lib/db/schema";
import { attachEventToSeries } from "@/lib/series/resolve-or-create-series";
import { eventVenueJoinProjection } from "@/lib/db/event-join-projection";
import { eq, desc } from "drizzle-orm";
import { createSlug, computePublicDates, dollarsToCents } from "@/lib/utils";
import { resolveUniqueEventSlug, insertEventDaysBatched } from "@/lib/events/insert-helpers";
import { validateRequestBody, promoterEventCreateSchema } from "@/lib/validations";
import { logError } from "@/lib/logger";
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
  // OPE-703 — a verified email before publishing to a public directory.
  //
  // Approved by John 2026-08-31 on a measured recommendation: this route's
  // ONLY callers are the promoter's own browser UI (src/app/promoter/events/
  // new/page.tsx), ingestion creates events through direct inserts and never
  // touches it, and all 6 real registered promoters were already verified when
  // this shipped. So it closes the last ungated owner-facing write at a cost of
  // zero affected accounts — the 717 "unverified" promoter owners are
  // `pending+…` ingestion placeholders that hold no session.
  const gate = await requireVerifiedSession();
  if (!gate.ok) return gate.response;
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
      // OPE-482: normalizeEventDate (noon UTC), NOT parseDateOnly (midnight
      // UTC). Midnight-UTC is 8pm Eastern the previous day, so those rows
      // render one day early. Same fix the PUT handler's discontinuous branch
      // already carries — this create path was the one it missed.
      startDate = normalizeEventDate(sorted[0])?.toISOString() ?? null;
      endDate = normalizeEventDate(sorted[sorted.length - 1])?.toISOString() ?? null;
    }

    // Auto-compute public date range (excluding vendor-only days).
    // OPE-543 — with no event_days there is no public span to derive, so NULL
    // rather than a copy of start/end that nothing later invalidates. Readers are
    // all `publicStartDate ?? startDate`.
    const { publicStartDate, publicEndDate } =
      eventDaysInput && eventDaysInput.length > 0
        ? computePublicDates(eventDaysInput)
        : { publicStartDate: null, publicEndDate: null };

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

    // OPE-627 — report-only duplicate check. Writes the flag; merges nothing.
    const possibleDuplicateOf = await detectPossibleDuplicate(db, {
      venueId: venueId || null,
      startDate: normalizeEventDate(startDate),
      endDate: normalizeEventDate(endDate),
      name,
      promoterId: promoter.id,
    });
    await db.insert(events).values({
      possibleDuplicateOf,
      id: eventId,
      name,
      slug,
      description,
      venueId: venueId || null,
      stateCode: resolvedStateCode,
      isStatewide: isStatewide ?? false,
      promoterId: promoter.id,
      // OPE-433 — named explicitly rather than inherited from the DDL default.
      //
      // A promoter entering their OWN event is the strongest provenance we
      // have, so `true` is right here — but it must be a decision the writer
      // states, not a default it silently picks up. Every other insert path
      // names these; these two were the only ones that did not.
      //
      // `syncEnabled: false` is the more consequential half: a promoter's own
      // data must not be clobbered by a later scraper run. Inheriting `true`
      // meant an importer could overwrite the organizer's own listing.
      datesConfirmed: true,
      syncEnabled: false,
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

    // OPE-472 — attach to a series parent at write time. `event_series`
    // minted nothing between 2026-06-30 and this fix, so every event from
    // this path was born without a hub. Best-effort, after the insert: the
    // event is durable and the parent is an enhancement.
    await attachEventToSeries(db, eventId, {
      name: name,
      venueId: venueId,
      promoterId: promoter.id,
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
