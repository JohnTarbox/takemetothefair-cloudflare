import { NextResponse } from "next/server";
import { z } from "zod";
import { gte, inArray, eq, and } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { events, venues, blogPosts } from "@/lib/db/schema";
import { PUBLIC_EVENT_STATUSES } from "@/lib/constants";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";

export const runtime = "edge";

const bodySchema = z.object({
  since: z.string().datetime(),
});

/**
 * POST /api/admin/indexnow/backfill
 * Bulk-resubmit URLs to IndexNow for all events/venues/blog posts that have
 * been updated since the given ISO timestamp AND are currently in their
 * public state. Useful after sitemap regeneration or recovery from extended
 * downtime.
 *
 * Auth: admin session OR X-Internal-Key.
 */
export async function POST(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "invalid_json" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "invalid_payload", message: "Provide { since: ISO8601 }" },
      { status: 400 }
    );
  }

  const since = new Date(parsed.data.since);

  const db = getCloudflareDb();
  const [eventRows, venueRows, blogRows] = await Promise.all([
    db
      .select({ slug: events.slug })
      .from(events)
      .where(and(inArray(events.status, [...PUBLIC_EVENT_STATUSES]), gte(events.updatedAt, since))),
    db
      .select({ slug: venues.slug })
      .from(venues)
      .where(and(eq(venues.status, "ACTIVE"), gte(venues.updatedAt, since))),
    db
      .select({ slug: blogPosts.slug })
      .from(blogPosts)
      .where(and(eq(blogPosts.status, "PUBLISHED"), gte(blogPosts.updatedAt, since))),
  ]);

  const urls = [
    ...eventRows.map((r) => indexNowUrlFor("events", r.slug)),
    ...venueRows.map((r) => indexNowUrlFor("venues", r.slug)),
    ...blogRows.map((r) => indexNowUrlFor("blog", r.slug)),
  ];

  const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
  await pingIndexNow(db, urls, env, "backfill");

  return NextResponse.json({
    success: true,
    counts: {
      events: eventRows.length,
      venues: venueRows.length,
      blogPosts: blogRows.length,
      total: urls.length,
    },
  });
}
