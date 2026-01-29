import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, eventDays } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createSlug } from "@/lib/utils";
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

    await db.insert(events).values({
      id: eventId,
      name: data.name,
      slug: createSlug(data.name),
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
    return NextResponse.json({ error: "Failed to create event" }, { status: 500 });
  }
}
