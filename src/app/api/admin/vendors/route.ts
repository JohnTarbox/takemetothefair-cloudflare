import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createSlug } from "@/lib/utils";
import { getVendorsWithCounts } from "@/lib/queries";
import { vendorCreateSchema, validateRequestBody } from "@/lib/validations";

export const runtime = "edge";

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = getCloudflareDb();
    const vendorsWithCounts = await getVendorsWithCounts(db);
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

  // Validate request body
  const validation = await validateRequestBody(request, vendorCreateSchema);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const data = validation.data;

  try {
    const db = getCloudflareDb();
    const vendorId = crypto.randomUUID();

    await db.insert(vendors).values({
      id: vendorId,
      userId: data.userId,
      businessName: data.businessName,
      slug: createSlug(data.businessName),
      description: data.description,
      vendorType: data.vendorType,
      products: JSON.stringify(data.products),
      website: data.website,
      socialLinks: data.socialLinks,
      logoUrl: data.logoUrl,
      verified: data.verified,
      commercial: data.commercial,
      // Contact Information
      contactName: data.contactName,
      contactEmail: data.contactEmail,
      contactPhone: data.contactPhone,
      // Physical Address
      address: data.address,
      city: data.city,
      state: data.state,
      zip: data.zip,
      // Business Details
      yearEstablished: data.yearEstablished,
      paymentMethods: JSON.stringify(data.paymentMethods),
      licenseInfo: data.licenseInfo,
      insuranceInfo: data.insuranceInfo,
    });

    // Update user role to VENDOR
    await db.update(users).set({ role: "VENDOR" }).where(eq(users.id, data.userId));

    const [newVendor] = await db
      .select()
      .from(vendors)
      .where(eq(vendors.id, vendorId))
      .limit(1);

    return NextResponse.json(newVendor, { status: 201 });
  } catch (error) {
    console.error("Failed to create vendor:", error);
    return NextResponse.json({ error: "Failed to create vendor" }, { status: 500 });
  }
}
