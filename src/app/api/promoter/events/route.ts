import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { promoters, events, venues, eventDays } from "@/lib/db/schema";
import { eq, desc, or, like } from "drizzle-orm";
import { createSlug, sanitizeLikeInput, findUniqueSlug } from "@/lib/utils";
import { validateRequestBody, promoterEventCreateSchema } from "@/lib/validations";
import { logError } from "@/lib/logger";

export const runtime = "edge";


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

    const eventResults = await db
      .select()
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(eq(events.promoterId, promoter.id))
      .orderBy(desc(events.createdAt));

    const eventsList = eventResults.map((r) => ({
      ...r.events,
      venue: r.venues ? { name: r.venues.name } : null,
    }));

    return NextResponse.json(eventsList);
  } catch (error) {
    await logError(db, { message: "Failed to fetch events", error, source: "api/promoter/events", request });
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
      startDate,
      endDate,
      categories,
      tags,
      ticketUrl,
      ticketPriceMin,
      ticketPriceMax,
      imageUrl,
      eventDays: eventDaysInput,
    } = validation.data;

    const baseSlug = createSlug(name);
    const escaped = sanitizeLikeInput(baseSlug);
    const existingSlugs = await db
      .select({ slug: events.slug })
      .from(events)
      .where(or(eq(events.slug, baseSlug), like(events.slug, `${escaped}-%`)));
    const slug = findUniqueSlug(baseSlug, existingSlugs.map((r) => r.slug));

    const eventId = crypto.randomUUID();

    await db.insert(events).values({
      id: eventId,
      name,
      slug,
      description,
      venueId: venueId || null,
      promoterId: promoter.id,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      categories: JSON.stringify(categories || []),
      tags: JSON.stringify(tags || []),
      ticketUrl,
      ticketPriceMin,
      ticketPriceMax,
      imageUrl,
      status: "PENDING",
    });

    // Insert event days if provided
    if (Array.isArray(eventDaysInput) && eventDaysInput.length > 0) {
      await db.insert(eventDays).values(
        eventDaysInput.map((day: { date: string; openTime: string; closeTime: string; notes?: string; closed?: boolean }) => ({
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

    const newEvent = await db
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);

    return NextResponse.json(newEvent[0], { status: 201 });
  } catch (error) {
    await logError(db, { message: "Failed to create event", error, source: "api/promoter/events", request });
    return NextResponse.json({ error: "Failed to create event" }, { status: 500 });
  }
}
