import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, eventDays } from "@/lib/db/schema";
import { eq, or, gt, lt, and } from "drizzle-orm";
import { createSlug, getSlugPrefixBounds, findUniqueSlug } from "@/lib/utils";
import { getEventsWithRelations } from "@/lib/queries";
import { eventCreateSchema, validateRequestBody } from "@/lib/validations";
import { logError } from "@/lib/logger";

export const runtime = "edge";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const status = searchParams.get("status");

  const db = getCloudflareDb();
  try {
    const eventsList = await getEventsWithRelations(db, {
      status: status || undefined,
      includeVendorCounts: true,
    });

    return NextResponse.json(eventsList);
  } catch (error) {
    await logError(db, { message: "Failed to fetch events", error, source: "api/admin/events", request });
    return NextResponse.json({ error: "Failed to fetch events" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Validate request body
  const validation = await validateRequestBody(request, eventCreateSchema);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const data = validation.data;

  const db = getCloudflareDb();
  try {
    const eventId = crypto.randomUUID();
    const baseSlug = createSlug(data.name);

    // Handle empty slug (e.g., name with only special characters)
    if (!baseSlug) {
      return NextResponse.json({ error: "Event name must contain alphanumeric characters" }, { status: 400 });
    }

    // Use string range comparison instead of LIKE to avoid "pattern too complex" errors
    const [lowerBound, upperBound] = getSlugPrefixBounds(baseSlug);
    const existing = await db
      .select({ slug: events.slug })
      .from(events)
      .where(or(
        eq(events.slug, baseSlug),
        and(gt(events.slug, lowerBound), lt(events.slug, upperBound))
      ));
    const slug = findUniqueSlug(baseSlug, existing.map((r) => r.slug));

    await db.insert(events).values({
      id: eventId,
      name: data.name,
      slug,
      description: data.description,
      venueId: data.venueId,
      promoterId: data.promoterId,
      startDate: data.startDate ? new Date(data.startDate) : null,
      endDate: data.endDate ? new Date(data.endDate) : null,
      datesConfirmed: data.datesConfirmed,
      categories: JSON.stringify(data.categories),
      tags: JSON.stringify(data.tags),
      ticketUrl: data.ticketUrl,
      ticketPriceMin: data.ticketPriceMin,
      ticketPriceMax: data.ticketPriceMax,
      imageUrl: data.imageUrl,
      featured: data.featured,
      commercialVendorsAllowed: data.commercialVendorsAllowed,
      status: data.status,
      sourceName: data.sourceName,
      sourceUrl: data.sourceUrl,
      sourceId: data.sourceId,
    });

    // Insert event days if provided
    if (data.eventDays && data.eventDays.length > 0) {
      await db.insert(eventDays).values(
        data.eventDays.map((day) => ({
          id: crypto.randomUUID(),
          eventId,
          date: day.date,
          openTime: day.openTime,
          closeTime: day.closeTime,
          notes: day.notes || null,
          closed: day.closed || false,
        }))
      );
    }

    const [newEvent] = await db
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);

    return NextResponse.json(newEvent, { status: 201 });
  } catch (error) {
    await logError(db, { message: "Failed to create event", error, source: "api/admin/events", request });
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE constraint failed") || message.includes("unique")) {
      return NextResponse.json({ error: "An event with this name already exists" }, { status: 409 });
    }
    if (message.includes("FOREIGN KEY constraint failed")) {
      return NextResponse.json({ error: "Invalid promoter or venue selected" }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to create event" }, { status: 500 });
  }
}
