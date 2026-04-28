import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { analyticsEvents } from "@/lib/db/schema";
import { desc, eq, gte, and, sql } from "drizzle-orm";

/**
 * GET /api/admin/analytics/events
 * Query first-party analytics events from D1.
 *
 * Query params:
 *   category - filter by event category
 *   name     - filter by event name
 *   days     - how many days back (default 30, max 365)
 *   limit    - max results (default 100, max 500)
 *
 * Response:
 *   { success: true, data: { events: [...], summary: [...] } }
 */
export async function GET(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json(
      { success: false, error: "unauthorized", message: "Admin access required" },
      { status: 401 }
    );
  }

  const url = new URL(request.url);
  const category = url.searchParams.get("category");
  const name = url.searchParams.get("name");
  const days = Math.min(parseInt(url.searchParams.get("days") || "30", 10), 365);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 500);

  const sinceTimestamp = Math.floor(Date.now() / 1000) - days * 86400;

  const db = getCloudflareDb();

  const conditions = [gte(analyticsEvents.timestamp, sinceTimestamp)];
  if (category) conditions.push(eq(analyticsEvents.eventCategory, category));
  if (name) conditions.push(eq(analyticsEvents.eventName, name));

  const events = await db
    .select()
    .from(analyticsEvents)
    .where(and(...conditions))
    .orderBy(desc(analyticsEvents.timestamp))
    .limit(limit);

  const summary = await db
    .select({
      eventName: analyticsEvents.eventName,
      count: sql<number>`COUNT(*)`,
    })
    .from(analyticsEvents)
    .where(gte(analyticsEvents.timestamp, sinceTimestamp))
    .groupBy(analyticsEvents.eventName);

  return NextResponse.json({
    success: true,
    data: { events, summary, daysWindow: days },
  });
}
