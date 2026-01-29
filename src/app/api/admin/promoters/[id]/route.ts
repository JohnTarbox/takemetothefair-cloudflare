import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { promoters, events, users } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { createSlug } from "@/lib/utils";
import { promoterUpdateSchema, validateRequestBody } from "@/lib/validations";
import { logError } from "@/lib/logger";

export const runtime = "edge";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const db = getCloudflareDb();
  try {
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
    await logError(db, { message: "Failed to fetch promoter", error, source: "api/admin/promoters/[id]", request });
    return NextResponse.json({ error: "Failed to fetch promoter" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  // Validate request body
  const validation = await validateRequestBody(request, promoterUpdateSchema);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const data = validation.data;

  const db = getCloudflareDb();
  try {
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.companyName) {
      updateData.companyName = data.companyName;
      updateData.slug = createSlug(data.companyName);
    }
    if (data.description !== undefined) updateData.description = data.description;
    if (data.website !== undefined) updateData.website = data.website;
    if (data.logoUrl !== undefined) updateData.logoUrl = data.logoUrl;
    if (data.verified !== undefined) updateData.verified = data.verified;

    await db.update(promoters).set(updateData).where(eq(promoters.id, id));

    const [updatedPromoter] = await db
      .select()
      .from(promoters)
      .where(eq(promoters.id, id))
      .limit(1);

    return NextResponse.json(updatedPromoter);
  } catch (error) {
    await logError(db, { message: "Failed to update promoter", error, source: "api/admin/promoters/[id]", request });
    return NextResponse.json({ error: "Failed to update promoter" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const db = getCloudflareDb();
  try {
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
    await logError(db, { message: "Failed to delete promoter", error, source: "api/admin/promoters/[id]", request });
    return NextResponse.json({ error: "Failed to delete promoter" }, { status: 500 });
  }
}
