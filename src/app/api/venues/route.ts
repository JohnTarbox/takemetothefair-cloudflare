import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { venues } from "@/lib/db/schema";
import { eq } from "drizzle-orm";


export async function GET() {
  try {
    const db = getCloudflareDb();
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
    console.error("Failed to fetch venues:", error);
    return NextResponse.json({ error: "Failed to fetch venues" }, { status: 500 });
  }
}
