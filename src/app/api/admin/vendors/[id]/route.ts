import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, eventVendors, events, users } from "@/lib/db/schema";
import { eq, and, ne } from "drizzle-orm";
import { createSlug } from "@/lib/utils";
import { vendorUpdateSchema, validateRequestBody } from "@/lib/validations";

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

  try {
    const db = getCloudflareDb();

    const vendorResults = await db
      .select()
      .from(vendors)
      .leftJoin(users, eq(vendors.userId, users.id))
      .where(eq(vendors.id, id))
      .limit(1);

    if (vendorResults.length === 0) {
      return NextResponse.json({ error: "Vendor not found" }, { status: 404 });
    }

    const vendor = vendorResults[0];

    const vendorEvents = await db
      .select()
      .from(eventVendors)
      .leftJoin(events, eq(eventVendors.eventId, events.id))
      .where(eq(eventVendors.vendorId, id));

    return NextResponse.json({
      ...vendor.vendors,
      user: vendor.users ? { email: vendor.users.email, name: vendor.users.name } : null,
      eventVendors: vendorEvents.map((ev) => ({
        ...ev.event_vendors,
        event: ev.events,
      })),
    });
  } catch (error) {
    console.error("Failed to fetch vendor:", error);
    return NextResponse.json({ error: "Failed to fetch vendor" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  // Validate request body
  const validation = await validateRequestBody(request, vendorUpdateSchema);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const data = validation.data;

  try {
    const db = getCloudflareDb();

    // Get current vendor to check if slug needs updating
    const [currentVendor] = await db
      .select({ slug: vendors.slug })
      .from(vendors)
      .where(eq(vendors.id, id))
      .limit(1);

    if (!currentVendor) {
      return NextResponse.json({ error: "Vendor not found" }, { status: 404 });
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.businessName) {
      updateData.businessName = data.businessName;
      const newSlug = createSlug(data.businessName);

      // Only update slug if it would change
      if (newSlug !== currentVendor.slug) {
        // Check if new slug already exists for another vendor
        const slug = newSlug;
        let slugSuffix = 0;
        while (true) {
          const existingSlug = await db
            .select({ id: vendors.id })
            .from(vendors)
            .where(and(
              eq(vendors.slug, slugSuffix > 0 ? `${slug}-${slugSuffix}` : slug),
              ne(vendors.id, id)
            ))
            .limit(1);
          if (existingSlug.length === 0) break;
          slugSuffix++;
        }
        updateData.slug = slugSuffix > 0 ? `${slug}-${slugSuffix}` : slug;
      }
    }
    if (data.description !== undefined) updateData.description = data.description;
    if (data.vendorType !== undefined) updateData.vendorType = data.vendorType;
    if (data.website !== undefined) updateData.website = data.website;
    if (data.logoUrl !== undefined) updateData.logoUrl = data.logoUrl;
    if (data.verified !== undefined) updateData.verified = data.verified;
    if (data.commercial !== undefined) updateData.commercial = data.commercial;
    // Contact Information
    if (data.contactName !== undefined) updateData.contactName = data.contactName;
    if (data.contactEmail !== undefined) updateData.contactEmail = data.contactEmail;
    if (data.contactPhone !== undefined) updateData.contactPhone = data.contactPhone;
    // Physical Address
    if (data.address !== undefined) updateData.address = data.address;
    if (data.city !== undefined) updateData.city = data.city;
    if (data.state !== undefined) updateData.state = data.state;
    if (data.zip !== undefined) updateData.zip = data.zip;
    // Business Details
    if (data.yearEstablished !== undefined) updateData.yearEstablished = data.yearEstablished;
    if (data.paymentMethods !== undefined) updateData.paymentMethods = JSON.stringify(data.paymentMethods);
    if (data.licenseInfo !== undefined) updateData.licenseInfo = data.licenseInfo;
    if (data.insuranceInfo !== undefined) updateData.insuranceInfo = data.insuranceInfo;

    await db.update(vendors).set(updateData).where(eq(vendors.id, id));

    const [updatedVendor] = await db
      .select()
      .from(vendors)
      .where(eq(vendors.id, id))
      .limit(1);

    return NextResponse.json(updatedVendor);
  } catch (error) {
    console.error("Failed to update vendor:", error);
    const message = error instanceof Error ? error.message : "Failed to update vendor";
    return NextResponse.json({ error: message }, { status: 500 });
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

    // Get vendor to find user
    const vendor = await db
      .select()
      .from(vendors)
      .where(eq(vendors.id, id))
      .limit(1);

    if (vendor.length > 0) {
      // Reset user role to USER
      await db.update(users).set({ role: "USER" }).where(eq(users.id, vendor[0].userId));
    }

    await db.delete(vendors).where(eq(vendors.id, id));
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete vendor:", error);
    return NextResponse.json({ error: "Failed to delete vendor" }, { status: 500 });
  }
}
