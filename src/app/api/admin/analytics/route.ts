import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { analyticsEvents } from "@/lib/db/schema";
import { desc, eq, gte, and, sql } from "drizzle-orm";

export const runtime = "edge";

/**
 * GET /api/admin/analytics
 * Query server-side analytics events.
 *
 * Query params:
 *   category - filter by event category
 *   name     - filter by event name
 *   days     - how many days back (default 30)
 *   limit    - max results (default 100)
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const category = url.searchParams.get("category");
  const name = url.searchParams.get("name");
  const days = parseInt(url.searchParams.get("days") || "30", 10);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 500);

  const sinceTimestamp = Math.floor(Date.now() / 1000) - days * 86400;

  const db = getCloudflareDb();

  const conditions = [gte(analyticsEvents.timestamp, sinceTimestamp)];
  if (category) conditions.push(eq(analyticsEvents.eventCategory, category));
  if (name) conditions.push(eq(analyticsEvents.eventName, name));

  const results = await db
    .select()
    .from(analyticsEvents)
    .where(and(...conditions))
    .orderBy(desc(analyticsEvents.timestamp))
    .limit(limit);

  // Also return summary counts
  const summary = await db
    .select({
      eventName: analyticsEvents.eventName,
      count: sql<number>`COUNT(*)`,
    })
    .from(analyticsEvents)
    .where(gte(analyticsEvents.timestamp, sinceTimestamp))
    .groupBy(analyticsEvents.eventName);

  return NextResponse.json({ events: results, summary });
}
