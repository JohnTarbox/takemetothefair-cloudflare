import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { promoters, events, venues } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { createSlug } from "@/lib/utils";

export const runtime = "edge";


export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = getCloudflareDb();

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
    console.error("Failed to fetch events:", error);
    return NextResponse.json({ error: "Failed to fetch events" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = getCloudflareDb();

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

    const body = await request.json() as Record<string, unknown>;
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
    } = body;

    let slug = createSlug(name);
    const existingEvent = await db
      .select()
      .from(events)
      .where(eq(events.slug, slug))
      .limit(1);

    if (existingEvent.length > 0) {
      slug = `${slug}-${Date.now()}`;
    }

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

    const newEvent = await db
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);

    return NextResponse.json(newEvent[0], { status: 201 });
  } catch (error) {
    console.error("Failed to create event:", error);
    return NextResponse.json({ error: "Failed to create event" }, { status: 500 });
  }
}
