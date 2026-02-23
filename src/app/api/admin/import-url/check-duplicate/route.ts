import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "edge";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = request.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ isDuplicate: false });
  }

  const db = getCloudflareDb();

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
}
