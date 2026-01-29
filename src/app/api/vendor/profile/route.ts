import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createSlug } from "@/lib/utils";
import { validateRequestBody, vendorProfileUpdateSchema } from "@/lib/validations";
import { logError } from "@/lib/logger";

export const runtime = "edge";


export async function GET(request: NextRequest) {
  const db = getCloudflareDb();
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
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
    await logError(db, { message: "Failed to fetch vendor profile", error, source: "api/vendor/profile", request });
    return NextResponse.json({ error: "Failed to fetch profile" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const db = getCloudflareDb();
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const validation = await validateRequestBody(request, vendorProfileUpdateSchema);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const {
      businessName, description, vendorType, products, website, logoUrl,
      contactName, contactEmail, contactPhone,
      address, city, state, zip,
      yearEstablished, paymentMethods, licenseInfo, insuranceInfo
    } = validation.data;

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
    // Contact Information
    if (contactName !== undefined) updateData.contactName = contactName;
    if (contactEmail !== undefined) updateData.contactEmail = contactEmail;
    if (contactPhone !== undefined) updateData.contactPhone = contactPhone;
    // Physical Address
    if (address !== undefined) updateData.address = address;
    if (city !== undefined) updateData.city = city;
    if (state !== undefined) updateData.state = state;
    if (zip !== undefined) updateData.zip = zip;
    // Business Details
    if (yearEstablished !== undefined) updateData.yearEstablished = yearEstablished;
    if (paymentMethods) updateData.paymentMethods = JSON.stringify(paymentMethods);
    if (licenseInfo !== undefined) updateData.licenseInfo = licenseInfo;
    if (insuranceInfo !== undefined) updateData.insuranceInfo = insuranceInfo;

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
    await logError(db, { message: "Failed to update vendor profile", error, source: "api/vendor/profile", request });
    return NextResponse.json({ error: "Failed to update profile" }, { status: 500 });
  }
}
