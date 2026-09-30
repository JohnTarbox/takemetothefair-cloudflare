export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { mergeProductsJson, routeVendorCategoriesForWrite } from "@takemetothefair/vendor-linking";
import { withAuth } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { vendors, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createSlug } from "@/lib/utils";
import { getVendorsWithCounts } from "@/lib/queries";
import { vendorCreateSchema, validateRequestBody } from "@/lib/validations";
import { logError } from "@/lib/logger";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";
import { recomputeVendorCompleteness } from "@/lib/completeness";
import { logEnrichment } from "@/lib/enrichment-log";

export const GET = withAuth({ role: "ADMIN" }, async ({ request, db }) => {
  try {
    const vendorsWithCounts = await getVendorsWithCounts(db);
    return NextResponse.json(vendorsWithCounts);
  } catch (error) {
    await logError(db, {
      message: "Failed to fetch vendors",
      error,
      source: "api/admin/vendors",
      request,
    });
    return NextResponse.json({ error: "Failed to fetch vendors" }, { status: 500 });
  }
});

export const POST = withAuth({ role: "ADMIN" }, async ({ request, db, session }) => {
  // Validate request body
  const validation = await validateRequestBody(request, vendorCreateSchema);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const data = validation.data;

  try {
    const vendorId = crypto.randomUUID();
    // OPE-1113/OPE-1164 — one spelling per category; a description in any
    // category field goes to products instead.
    const routed = await routeVendorCategoriesForWrite(db, {
      vendorType: data.vendorType,
      sellsCategory: data.sellsCategory,
      businessSector: data.businessSector,
      vendorIdentity: data.vendorIdentity,
    });

    await db.insert(vendors).values({
      id: vendorId,
      userId: data.userId,
      businessName: data.businessName,
      slug: createSlug(data.businessName),
      description: data.description,
      vendorType: routed.values.vendorType ?? null,
      sellsCategory: routed.values.sellsCategory ?? null,
      businessSector: routed.values.businessSector ?? null,
      vendorIdentity: routed.values.vendorIdentity ?? null,
      products: mergeProductsJson(JSON.stringify(data.products), routed.productsToAdd),
      website: data.website,
      socialLinks: data.socialLinks,
      logoUrl: data.logoUrl,
      verified: data.verified,
      commercial: data.commercial,
      canSelfConfirm: data.canSelfConfirm,
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

    await recomputeVendorCompleteness(db, vendorId);

    await logEnrichment(db, {
      targetType: "vendor",
      targetId: vendorId,
      source: "manual_admin",
      status: "success",
      actorUserId: session.user.id,
      notes: "admin create_vendor",
    });

    const [newVendor] = await db.select().from(vendors).where(eq(vendors.id, vendorId)).limit(1);

    if (newVendor?.slug) {
      const env = getCloudflareEnv();
      await pingIndexNow(db, indexNowUrlFor("vendors", newVendor.slug), env, "vendor-create");
    }

    return NextResponse.json(newVendor, { status: 201 });
  } catch (error) {
    await logError(db, {
      message: "Failed to create vendor",
      error,
      source: "api/admin/vendors",
      request,
    });
    return NextResponse.json({ error: "Failed to create vendor" }, { status: 500 });
  }
});
