import { NextRequest, NextResponse } from "next/server";
import { and, eq, gt, lt, or } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { promoters, events, eventDays } from "@/lib/db/schema";
import {
  createSlug,
  getSlugPrefixBounds,
  findUniqueSlug,
  computePublicDates,
  dollarsToCents,
} from "@/lib/utils";
import { validateRequestBody, promoterEventCreateSchema } from "@/lib/validations";
import { logError } from "@/lib/logger";
import { parseDateOnly } from "@/lib/datetime";

export const runtime = "edge";

interface EventDayInput {
  date: string;
  openTime: string;
  closeTime: string;
  notes?: string | null;
  closed?: boolean;
  vendorOnly?: boolean;
}

/**
 * Draft-save / submit endpoint for the promoter event wizard.
 *
 * Body is the same shape as POST /api/promoter/events, plus:
 *   - id?: existing event id to update (must belong to the signed-in promoter
 *          AND currently be in DRAFT status)
 *   - submit?: when true, transitions DRAFT → PENDING
 *
 * Without id: creates a new DRAFT event.
 * With id: updates the existing DRAFT (and optionally submits).
 * Returns { id, slug, status }.
 */
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

    // Parse raw body to pick up id/submit before validation trims them.
    const raw = (await request
      .clone()
      .json()
      .catch(() => ({}))) as {
      id?: string;
      submit?: boolean;
    };
    const existingId = typeof raw.id === "string" ? raw.id : undefined;
    const submit = raw.submit === true;

    const validation = await validateRequestBody(request, promoterEventCreateSchema);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const data = validation.data;

    const isDiscontinuous = !!data.discontinuousDates;
    const eventDaysInput = (data.eventDays ?? []) as EventDayInput[];

    // Compute overall start/end from eventDays if discontinuous
    let startDate = data.startDate ?? null;
    let endDate = data.endDate ?? null;
    if (isDiscontinuous && eventDaysInput.length > 0) {
      const sorted = eventDaysInput.map((d) => d.date).sort();
      startDate = parseDateOnly(sorted[0])?.toISOString() ?? null;
      endDate = parseDateOnly(sorted[sorted.length - 1])?.toISOString() ?? null;
    }

    // Public date range (excludes vendor-only days)
    const { publicStartDate, publicEndDate } =
      eventDaysInput.length > 0
        ? computePublicDates(eventDaysInput)
        : {
            publicStartDate: startDate ? new Date(startDate) : null,
            publicEndDate: endDate ? new Date(endDate) : null,
          };

    const finalStatus = submit ? "PENDING" : "DRAFT";

    // ─── Update existing draft ─────────────────────────────────────────
    if (existingId) {
      const [existing] = await db
        .select()
        .from(events)
        .where(and(eq(events.id, existingId), eq(events.promoterId, promoter.id)))
        .limit(1);
      if (!existing) {
        return NextResponse.json({ error: "Draft not found" }, { status: 404 });
      }
      if (existing.status !== "DRAFT") {
        return NextResponse.json(
          { error: "Only DRAFT events can be updated through this endpoint." },
          { status: 400 }
        );
      }

      await db
        .update(events)
        .set({
          name: data.name,
          description: data.description,
          venueId: data.venueId || null,
          stateCode: data.stateCode || null,
          isStatewide: data.isStatewide ?? false,
          startDate: startDate ? new Date(startDate) : null,
          endDate: endDate ? new Date(endDate) : null,
          publicStartDate,
          publicEndDate,
          discontinuousDates: isDiscontinuous,
          categories: JSON.stringify(data.categories ?? []),
          tags: JSON.stringify(data.tags ?? []),
          ticketUrl: data.ticketUrl,
          ticketPriceMinCents: dollarsToCents(data.ticketPriceMin),
          ticketPriceMaxCents: dollarsToCents(data.ticketPriceMax),
          imageUrl: data.imageUrl,
          vendorFeeMinCents: dollarsToCents(data.vendorFeeMin),
          vendorFeeMaxCents: dollarsToCents(data.vendorFeeMax),
          vendorFeeNotes: data.vendorFeeNotes,
          indoorOutdoor: data.indoorOutdoor,
          estimatedAttendance: data.estimatedAttendance,
          eventScale: data.eventScale,
          applicationDeadline: data.applicationDeadline ? new Date(data.applicationDeadline) : null,
          applicationUrl: data.applicationUrl,
          applicationInstructions: data.applicationInstructions,
          walkInsAllowed: data.walkInsAllowed,
          status: finalStatus,
          updatedAt: new Date(),
        })
        .where(eq(events.id, existingId));

      // Replace event days wholesale — simpler than diffing
      await db.delete(eventDays).where(eq(eventDays.eventId, existingId));
      if (eventDaysInput.length > 0) {
        await db.insert(eventDays).values(
          eventDaysInput.map((d) => ({
            id: crypto.randomUUID(),
            eventId: existingId,
            date: d.date,
            openTime: d.openTime,
            closeTime: d.closeTime,
            notes: d.notes ?? null,
            closed: d.closed ?? false,
            vendorOnly: d.vendorOnly ?? false,
          }))
        );
      }

      return NextResponse.json({
        id: existingId,
        slug: existing.slug,
        status: finalStatus,
      });
    }

    // ─── Create new draft ──────────────────────────────────────────────
    const baseSlug = createSlug(data.name);
    if (!baseSlug) {
      return NextResponse.json(
        { error: "Event name must contain alphanumeric characters" },
        { status: 400 }
      );
    }

    const [lower, upper] = getSlugPrefixBounds(baseSlug);
    const existingSlugs = await db
      .select({ slug: events.slug })
      .from(events)
      .where(or(eq(events.slug, baseSlug), and(gt(events.slug, lower), lt(events.slug, upper))));
    const slug = findUniqueSlug(
      baseSlug,
      existingSlugs.map((r) => r.slug)
    );

    const newId = crypto.randomUUID();
    await db.insert(events).values({
      id: newId,
      name: data.name,
      slug,
      description: data.description,
      venueId: data.venueId || null,
      stateCode: data.stateCode || null,
      isStatewide: data.isStatewide ?? false,
      promoterId: promoter.id,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      publicStartDate,
      publicEndDate,
      discontinuousDates: isDiscontinuous,
      categories: JSON.stringify(data.categories ?? []),
      tags: JSON.stringify(data.tags ?? []),
      ticketUrl: data.ticketUrl,
      ticketPriceMinCents: dollarsToCents(data.ticketPriceMin),
      ticketPriceMaxCents: dollarsToCents(data.ticketPriceMax),
      imageUrl: data.imageUrl,
      status: finalStatus,
      vendorFeeMinCents: dollarsToCents(data.vendorFeeMin),
      vendorFeeMaxCents: dollarsToCents(data.vendorFeeMax),
      vendorFeeNotes: data.vendorFeeNotes,
      indoorOutdoor: data.indoorOutdoor,
      estimatedAttendance: data.estimatedAttendance,
      eventScale: data.eventScale,
      applicationDeadline: data.applicationDeadline ? new Date(data.applicationDeadline) : null,
      applicationUrl: data.applicationUrl,
      applicationInstructions: data.applicationInstructions,
      walkInsAllowed: data.walkInsAllowed,
    });

    if (eventDaysInput.length > 0) {
      await db.insert(eventDays).values(
        eventDaysInput.map((d) => ({
          id: crypto.randomUUID(),
          eventId: newId,
          date: d.date,
          openTime: d.openTime,
          closeTime: d.closeTime,
          notes: d.notes ?? null,
          closed: d.closed ?? false,
          vendorOnly: d.vendorOnly ?? false,
        }))
      );
    }

    return NextResponse.json({ id: newId, slug, status: finalStatus }, { status: 201 });
  } catch (error) {
    await logError(db, {
      message: "Failed to save draft",
      error,
      source: "api/promoter/events/draft",
      request,
    });
    return NextResponse.json({ error: "Failed to save draft" }, { status: 500 });
  }
}

/**
 * Load a draft (or any promoter-owned event) for prefilling the wizard.
 * Used by "duplicate" and "continue editing" flows.
 */
export async function GET(request: NextRequest) {
  const db = getCloudflareDb();
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  try {
    const [promoter] = await db
      .select()
      .from(promoters)
      .where(eq(promoters.userId, session.user.id))
      .limit(1);
    if (!promoter) {
      return NextResponse.json({ error: "Promoter profile not found" }, { status: 404 });
    }

    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, id), eq(events.promoterId, promoter.id)))
      .limit(1);
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const days = await db
      .select()
      .from(eventDays)
      .where(eq(eventDays.eventId, id))
      .orderBy(eventDays.date);

    return NextResponse.json({ event, eventDays: days });
  } catch (error) {
    await logError(db, {
      message: "Failed to load draft",
      error,
      source: "api/promoter/events/draft:GET",
      request,
    });
    return NextResponse.json({ error: "Failed to load draft" }, { status: 500 });
  }
}
