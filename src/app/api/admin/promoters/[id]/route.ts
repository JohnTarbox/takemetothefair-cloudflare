import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { promoters, events, users } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { createSlug } from "@/lib/utils";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const db = getCloudflareDb();

    const promoterResults = await db
      .select()
      .from(promoters)
      .leftJoin(users, eq(promoters.userId, users.id))
      .where(eq(promoters.id, id))
      .limit(1);

    if (promoterResults.length === 0) {
      return NextResponse.json({ error: "Promoter not found" }, { status: 404 });
    }

    const promoter = promoterResults[0];

    const promoterEvents = await db
      .select()
      .from(events)
      .where(eq(events.promoterId, id))
      .orderBy(desc(events.startDate))
      .limit(10);

    return NextResponse.json({
      ...promoter.promoters,
      user: promoter.users ? { email: promoter.users.email, name: promoter.users.name } : null,
      events: promoterEvents,
    });
  } catch (error) {
    console.error("Failed to fetch promoter:", error);
    return NextResponse.json({ error: "Failed to fetch promoter" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const body = await request.json();
    const { companyName, description, website, logoUrl, verified } = body;

    const db = getCloudflareDb();

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (companyName) {
      updateData.companyName = companyName;
      updateData.slug = createSlug(companyName);
    }
    if (description !== undefined) updateData.description = description;
    if (website !== undefined) updateData.website = website;
    if (logoUrl !== undefined) updateData.logoUrl = logoUrl;
    if (verified !== undefined) updateData.verified = verified;

    await db.update(promoters).set(updateData).where(eq(promoters.id, id));

    const updatedPromoter = await db
      .select()
      .from(promoters)
      .where(eq(promoters.id, id))
      .limit(1);

    return NextResponse.json(updatedPromoter[0]);
  } catch (error) {
    console.error("Failed to update promoter:", error);
    return NextResponse.json({ error: "Failed to update promoter" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const db = getCloudflareDb();

    // Get promoter to find user
    const promoter = await db
      .select()
      .from(promoters)
      .where(eq(promoters.id, id))
      .limit(1);

    if (promoter.length > 0) {
      // Reset user role to USER
      await db.update(users).set({ role: "USER" }).where(eq(users.id, promoter[0].userId));
    }

    await db.delete(promoters).where(eq(promoters.id, id));
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete promoter:", error);
    return NextResponse.json({ error: "Failed to delete promoter" }, { status: 500 });
  }
}
