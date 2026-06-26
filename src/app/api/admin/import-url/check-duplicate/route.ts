export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { events } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const GET = withAuth({ role: "ADMIN" }, async ({ request, db }) => {
  const url = request.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ isDuplicate: false });
  }

  const existing = await db
    .select({
      id: events.id,
      name: events.name,
      slug: events.slug,
    })
    .from(events)
    .where(eq(events.sourceUrl, url))
    .limit(1);

  if (existing.length > 0) {
    return NextResponse.json({
      isDuplicate: true,
      existingEvent: existing[0],
    });
  }

  return NextResponse.json({ isDuplicate: false });
});
