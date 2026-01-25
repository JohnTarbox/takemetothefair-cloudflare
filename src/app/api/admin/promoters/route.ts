import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { promoters, events, users } from "@/lib/db/schema";
import { eq, count } from "drizzle-orm";
import { createSlug } from "@/lib/utils";

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = getCloudflareDb();
    const promoterList = await db
      .select()
      .from(promoters)
      .leftJoin(users, eq(promoters.userId, users.id))
      .orderBy(promoters.companyName);

    const promotersWithCounts = await Promise.all(
      promoterList.map(async (p) => {
        const eventCount = await db
          .select({ count: count() })
          .from(events)
          .where(eq(events.promoterId, p.promoters.id));

        return {
          ...p.promoters,
          user: p.users ? { email: p.users.email, name: p.users.name } : null,
          _count: { events: eventCount[0]?.count || 0 },
        };
      })
    );

    return NextResponse.json(promotersWithCounts);
  } catch (error) {
    console.error("Failed to fetch promoters:", error);
    return NextResponse.json({ error: "Failed to fetch promoters" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { userId, companyName, description, website, logoUrl } = body;

    const db = getCloudflareDb();
    const promoterId = crypto.randomUUID();

    await db.insert(promoters).values({
      id: promoterId,
      userId,
      companyName,
      slug: createSlug(companyName),
      description,
      website,
      logoUrl,
      verified: false,
    });

    // Update user role to PROMOTER
    await db.update(users).set({ role: "PROMOTER" }).where(eq(users.id, userId));

    const newPromoter = await db
      .select()
      .from(promoters)
      .where(eq(promoters.id, promoterId))
      .limit(1);

    return NextResponse.json(newPromoter[0], { status: 201 });
  } catch (error) {
    console.error("Failed to create promoter:", error);
    return NextResponse.json({ error: "Failed to create promoter" }, { status: 500 });
  }
}
