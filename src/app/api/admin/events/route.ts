import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, promoters } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { createSlug } from "@/lib/utils";

export const runtime = "edge";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const status = searchParams.get("status");

  try {
    const db = getCloudflareDb();

    let query = db
      .select()
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .orderBy(desc(events.createdAt));

    if (status) {
      query = db
        .select()
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .leftJoin(promoters, eq(events.promoterId, promoters.id))
        .where(eq(events.status, status))
        .orderBy(desc(events.createdAt));
    }

    const results = await query;

    const eventsList = results.map((r) => ({
      ...r.events,
      venue: r.venues ? { name: r.venues.name } : null,
      promoter: r.promoters ? { companyName: r.promoters.companyName } : null,
    }));

    return NextResponse.json(eventsList);
  } catch (error) {
    console.error("Failed to fetch events:", error);
    return NextResponse.json({ error: "Failed to fetch events" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const {
      name,
      description,
      venueId,
      promoterId,
      startDate,
      endDate,
      categories,
      tags,
      ticketUrl,
      ticketPriceMin,
      ticketPriceMax,
      imageUrl,
      featured,
      status,
    } = body;

    const db = getCloudflareDb();
    const eventId = crypto.randomUUID();

    await db.insert(events).values({
      id: eventId,
      name,
      slug: createSlug(name),
      description,
      venueId,
      promoterId,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      categories: JSON.stringify(categories || []),
      tags: JSON.stringify(tags || []),
      ticketUrl,
      ticketPriceMin,
      ticketPriceMax,
      imageUrl,
      featured: featured || false,
      status: status || "APPROVED",
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
