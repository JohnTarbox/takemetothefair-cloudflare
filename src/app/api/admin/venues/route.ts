import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { venues, events } from "@/lib/db/schema";
import { eq, count } from "drizzle-orm";
import { createSlug } from "@/lib/utils";


export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = getCloudflareDb();

    const venueList = await db
      .select()
      .from(venues)
      .orderBy(venues.name);

    // Get event counts for each venue
    const venuesWithCounts = await Promise.all(
      venueList.map(async (venue) => {
        const eventCount = await db
          .select({ count: count() })
          .from(events)
          .where(eq(events.venueId, venue.id));

        return {
          ...venue,
          _count: { events: eventCount[0]?.count || 0 },
        };
      })
    );

    return NextResponse.json(venuesWithCounts);
  } catch (error) {
    console.error("Failed to fetch venues:", error);
    return NextResponse.json({ error: "Failed to fetch venues" }, { status: 500 });
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
      address,
      city,
      state,
      zip,
      latitude,
      longitude,
      capacity,
      amenities,
      contactEmail,
      contactPhone,
      website,
      description,
      imageUrl,
      status,
    } = body;

    const db = getCloudflareDb();
    const venueId = crypto.randomUUID();

    await db.insert(venues).values({
      id: venueId,
      name,
      slug: createSlug(name),
      address,
      city,
      state,
      zip,
      latitude,
      longitude,
      capacity,
      amenities: JSON.stringify(amenities || []),
      contactEmail,
      contactPhone,
      website,
      description,
      imageUrl,
      status: status || "ACTIVE",
    });

    const newVenue = await db
      .select()
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);

    return NextResponse.json(newVenue[0], { status: 201 });
  } catch (error) {
    console.error("Failed to create venue:", error);
    return NextResponse.json({ error: "Failed to create venue" }, { status: 500 });
  }
}
