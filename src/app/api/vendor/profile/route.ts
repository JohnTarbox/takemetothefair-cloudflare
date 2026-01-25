import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createSlug } from "@/lib/utils";

export const runtime = "edge";


export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = getCloudflareDb();
    const vendor = await db
      .select()
      .from(vendors)
      .where(eq(vendors.userId, session.user.id))
      .limit(1);

    if (vendor.length === 0) {
      return NextResponse.json({ error: "Vendor profile not found" }, { status: 404 });
    }

    return NextResponse.json(vendor[0]);
  } catch (error) {
    console.error("Failed to fetch vendor profile:", error);
    return NextResponse.json({ error: "Failed to fetch profile" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json() as Record<string, unknown>;
    const { businessName, description, vendorType, products, website, logoUrl } =
      body;

    const db = getCloudflareDb();

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (businessName) {
      updateData.businessName = businessName;
      updateData.slug = createSlug(businessName);
    }
    if (description !== undefined) updateData.description = description;
    if (vendorType !== undefined) updateData.vendorType = vendorType;
    if (products) updateData.products = JSON.stringify(products);
    if (website !== undefined) updateData.website = website;
    if (logoUrl !== undefined) updateData.logoUrl = logoUrl;

    await db
      .update(vendors)
      .set(updateData)
      .where(eq(vendors.userId, session.user.id));

    const updatedVendor = await db
      .select()
      .from(vendors)
      .where(eq(vendors.userId, session.user.id))
      .limit(1);

    return NextResponse.json(updatedVendor[0]);
  } catch (error) {
    console.error("Failed to update vendor profile:", error);
    return NextResponse.json({ error: "Failed to update profile" }, { status: 500 });
  }
}
