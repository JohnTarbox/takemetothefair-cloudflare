import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { promoters, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createSlug } from "@/lib/utils";
import { getPromotersWithCounts } from "@/lib/queries";
import { promoterCreateSchema, validateRequestBody } from "@/lib/validations";

export const runtime = "edge";

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = getCloudflareDb();
    const promotersWithCounts = await getPromotersWithCounts(db);
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

  // Validate request body
  const validation = await validateRequestBody(request, promoterCreateSchema);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const data = validation.data;

  try {
    const db = getCloudflareDb();
    const promoterId = crypto.randomUUID();

    await db.insert(promoters).values({
      id: promoterId,
      userId: data.userId,
      companyName: data.companyName,
      slug: createSlug(data.companyName),
      description: data.description,
      website: data.website,
      socialLinks: data.socialLinks,
      logoUrl: data.logoUrl,
      verified: data.verified,
    });

    // Update user role to PROMOTER
    await db.update(users).set({ role: "PROMOTER" }).where(eq(users.id, data.userId));

    const [newPromoter] = await db
      .select()
      .from(promoters)
      .where(eq(promoters.id, promoterId))
      .limit(1);

    return NextResponse.json(newPromoter, { status: 201 });
  } catch (error) {
    console.error("Failed to create promoter:", error);
    return NextResponse.json({ error: "Failed to create promoter" }, { status: 500 });
  }
}
