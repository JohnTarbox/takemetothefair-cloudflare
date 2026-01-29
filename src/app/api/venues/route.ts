import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { venues } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { logError } from "@/lib/logger";

export const runtime = "edge";


export async function GET(request: Request) {
  const db = getCloudflareDb();
  try {
    const venueList = await db
      .select({
        id: venues.id,
        name: venues.name,
        city: venues.city,
        state: venues.state,
      })
      .from(venues)
      .where(eq(venues.status, "ACTIVE"))
      .orderBy(venues.name);

    return NextResponse.json(venueList);
  } catch (error) {
    await logError(db, { message: "Failed to fetch venues", error, source: "api/venues", request });
    return NextResponse.json({ error: "Failed to fetch venues" }, { status: 500 });
  }
}
