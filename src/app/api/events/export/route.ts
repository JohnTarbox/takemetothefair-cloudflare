import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues } from "@/lib/db/schema";
import { eq, and, gte, like, or } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { sanitizeLikeInput } from "@/lib/utils";
import { logError } from "@/lib/logger";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export const runtime = "edge";

export async function GET(request: Request) {
  // Rate limiting check
  const rateLimitResult = await checkRateLimit(request, "export-events");
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getCloudflareDb();
  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get("query");
    const category = searchParams.get("category");
    const state = searchParams.get("state");
    const featured = searchParams.get("featured");
    const commercialVendors = searchParams.get("commercialVendors");
    const includePast = searchParams.get("includePast");

    // Build conditions (same as the events page)
    const conditions = [eq(events.status, "APPROVED")];

    if (includePast !== "true") {
      conditions.push(gte(events.endDate, new Date()));
    }

    if (query) {
      const safeQuery = sanitizeLikeInput(query);
      conditions.push(
        or(
          like(events.name, `%${safeQuery}%`),
          like(events.description, `%${safeQuery}%`)
        )!
      );
    }

    if (category) {
      conditions.push(like(events.categories, `%${sanitizeLikeInput(category)}%`));
    }

    if (featured === "true") {
      conditions.push(eq(events.featured, true));
    }

    if (commercialVendors === "true") {
      conditions.push(eq(events.commercialVendorsAllowed, true));
    }

    // Fetch all events with venue data
    let results;
    if (state) {
      results = await db
        .select()
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .where(and(...conditions, eq(venues.state, state)))
        .orderBy(events.startDate);
    } else {
      results = await db
        .select()
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .where(and(...conditions))
        .orderBy(events.startDate);
    }

    // Format date for CSV
    const formatDate = (date: Date | string) => {
      const d = new Date(date);
      return d.toLocaleDateString("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    };

    // Escape CSV values
    const escapeCSV = (value: string | null | undefined) => {
      if (value === null || value === undefined) return "";
      const str = String(value);
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    // Build CSV
    const headers = ["Event", "Venue", "City", "State", "Start Date", "End Date", "Website"];
    const rows = results.map((r) => [
      escapeCSV(r.events.name),
      escapeCSV(r.venues?.name),
      escapeCSV(r.venues?.city),
      escapeCSV(r.venues?.state),
      formatDate(r.events.startDate),
      formatDate(r.events.endDate),
      escapeCSV(r.events.ticketUrl),
    ]);

    const csvContent = [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");

    // Return CSV response
    return new NextResponse(csvContent, {
      headers: {
        "Content-Type": "text/csv;charset=utf-8",
        "Content-Disposition": `attachment; filename="events-${new Date().toISOString().split("T")[0]}.csv"`,
      },
    });
  } catch (error) {
    await logError(db, { message: "Error exporting events", error, source: "api/events/export", request });
    return NextResponse.json({ error: "Failed to export events" }, { status: 500 });
  }
}
