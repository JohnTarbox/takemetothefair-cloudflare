import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { venues } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { parseJsonArray } from "@/types";
import { auth } from "@/lib/auth";
import { sanitizeLikeInput } from "@/lib/utils";
import { logError } from "@/lib/logger";

export const runtime = "edge";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getCloudflareDb();
  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get("q");
    const state = searchParams.get("state");

    // Build conditions
    const conditions = [eq(venues.status, "ACTIVE")];

    if (state) {
      conditions.push(eq(venues.state, state));
    }

    if (query) {
      conditions.push(
        sql`(${venues.name} LIKE ${'%' + sanitizeLikeInput(query) + '%'} OR ${venues.city} LIKE ${'%' + sanitizeLikeInput(query) + '%'})`
      );
    }

    // Fetch all venues with event counts
    const results = await db
      .select({
        id: venues.id,
        name: venues.name,
        address: venues.address,
        city: venues.city,
        state: venues.state,
        zip: venues.zip,
        capacity: venues.capacity,
        amenities: venues.amenities,
        website: venues.website,
        eventCount: sql<number>`(
          SELECT COUNT(*) FROM events
          WHERE events.venue_id = venues.id
          AND events.status = 'APPROVED'
          AND events.end_date >= unixepoch('now')
        )`.as('event_count'),
      })
      .from(venues)
      .where(and(...conditions))
      .orderBy(venues.name);

    // Escape CSV values
    const escapeCSV = (value: string | number | null | undefined) => {
      if (value === null || value === undefined) return "";
      const str = String(value);
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    // Build CSV
    const headers = ["Venue", "Address", "City", "State", "Zip", "Capacity", "Amenities", "Website", "Upcoming Events"];
    const rows = results.map((v) => {
      const amenities = parseJsonArray(v.amenities);
      return [
        escapeCSV(v.name),
        escapeCSV(v.address),
        escapeCSV(v.city),
        escapeCSV(v.state),
        escapeCSV(v.zip),
        escapeCSV(v.capacity),
        escapeCSV(amenities.join("; ")),
        escapeCSV(v.website),
        escapeCSV(v.eventCount || 0),
      ];
    });

    const csvContent = [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");

    // Return CSV response
    return new NextResponse(csvContent, {
      headers: {
        "Content-Type": "text/csv;charset=utf-8",
        "Content-Disposition": `attachment; filename="venues-${new Date().toISOString().split("T")[0]}.csv"`,
      },
    });
  } catch (error) {
    await logError(db, { message: "Error exporting venues", error, source: "api/venues/export", request });
    return NextResponse.json({ error: "Failed to export venues" }, { status: 500 });
  }
}
