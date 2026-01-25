import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, eventVendors, users } from "@/lib/db/schema";
import { eq, count } from "drizzle-orm";
import { createSlug } from "@/lib/utils";

export const runtime = "edge";

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = getCloudflareDb();
    const vendorList = await db
      .select()
      .from(vendors)
      .leftJoin(users, eq(vendors.userId, users.id))
      .orderBy(vendors.businessName);

    const vendorsWithCounts = await Promise.all(
      vendorList.map(async (v) => {
        const eventCount = await db
          .select({ count: count() })
          .from(eventVendors)
          .where(eq(eventVendors.vendorId, v.vendors.id));

        return {
          ...v.vendors,
          user: v.users ? { email: v.users.email, name: v.users.name } : null,
          _count: { events: eventCount[0]?.count || 0 },
        };
      })
    );

    return NextResponse.json(vendorsWithCounts);
  } catch (error) {
    console.error("Failed to fetch vendors:", error);
    return NextResponse.json({ error: "Failed to fetch vendors" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json() as Record<string, unknown>;
    const { userId, businessName, description, vendorType, website, logoUrl } = body;

    const db = getCloudflareDb();
    const vendorId = crypto.randomUUID();

    await db.insert(vendors).values({
      id: vendorId,
      userId,
      businessName,
      slug: createSlug(businessName),
      description,
      vendorType,
      website,
      logoUrl,
      verified: false,
    });

    // Update user role to VENDOR
    await db.update(users).set({ role: "VENDOR" }).where(eq(users.id, userId));

    const newVendor = await db
      .select()
      .from(vendors)
      .where(eq(vendors.id, vendorId))
      .limit(1);

    return NextResponse.json(newVendor[0], { status: 201 });
  } catch (error) {
    console.error("Failed to create vendor:", error);
    return NextResponse.json({ error: "Failed to create vendor" }, { status: 500 });
  }
}
