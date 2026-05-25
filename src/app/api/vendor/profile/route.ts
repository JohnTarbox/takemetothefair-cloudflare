import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireVerifiedSession } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { vendors, vendorSlugHistory } from "@/lib/db/schema";
import { and, eq, ne } from "drizzle-orm";
import { appendSlugSegment, createSlug, type Slug } from "@/lib/utils";
import { validateRequestBody, vendorProfileUpdateSchema } from "@/lib/validations";
import { logError } from "@/lib/logger";
import { recomputeVendorCompleteness } from "@/lib/completeness";
import { logEnrichment } from "@/lib/enrichment-log";
import { indexNowUrlFor, pingIndexNow } from "@/lib/indexnow";

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
    await logError(db, {
      message: "Failed to fetch vendor profile",
      error,
      source: "api/vendor/profile",
      request,
    });
    return NextResponse.json({ error: "Failed to fetch profile" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const db = getCloudflareDb();
  // Gate vendor profile EDIT on email verification. Read (GET above)
  // remains open — only writes require proof of email control. This
  // closes the gap where an unverified password-signup could create a
  // vendor row at registration and immediately edit anyone-else's
  // claimable listing data without ever clicking the verification
  // link. OAuth signups are auto-verified at user-create time so
  // they pass this gate transparently.
  const gate = await requireVerifiedSession();
  if (!gate.ok) return gate.response;

  try {
    const validation = await validateRequestBody(request, vendorProfileUpdateSchema);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const {
      businessName,
      description,
      vendorType,
      products,
      website,
      logoUrl,
      contactName,
      contactEmail,
      contactPhone,
      address,
      city,
      state,
      zip,
      latitude,
      longitude,
      yearEstablished,
      paymentMethods,
      licenseInfo,
      insuranceInfo,
    } = validation.data;

    // Snapshot current vendor for slug-change detection, slug history,
    // and IndexNow material-change comparison. Mirrors the admin PATCH at
    // src/app/api/admin/vendors/[id]/route.ts — keeping the self-edit
    // surface in parity so renames don't silently break branded URLs.
    const [currentVendor] = await db
      .select({
        id: vendors.id,
        slug: vendors.slug,
        businessName: vendors.businessName,
        vendorType: vendors.vendorType,
        description: vendors.description,
        city: vendors.city,
        state: vendors.state,
        logoUrl: vendors.logoUrl,
      })
      .from(vendors)
      .where(eq(vendors.userId, gate.userId))
      .limit(1);

    if (!currentVendor) {
      return NextResponse.json({ error: "Vendor profile not found" }, { status: 404 });
    }

    const now = new Date();
    const updateData: Record<string, unknown> = { updatedAt: now };
    let resolvedSlug: Slug | null = null;
    if (businessName) {
      updateData.businessName = businessName;
      const slugSeed = createSlug(businessName);
      if (slugSeed !== currentVendor.slug) {
        // Collision loop: append -1, -2, … until a free slug is found,
        // excluding our own row. Without this, a rename to a name an
        // existing vendor owns hits the UNIQUE constraint and returns
        // an opaque 500.
        let suffix = 0;
        let candidate: Slug = slugSeed;
        while (true) {
          const probe = suffix > 0 ? appendSlugSegment(slugSeed, suffix) : slugSeed;
          const taken = await db
            .select({ id: vendors.id })
            .from(vendors)
            .where(and(eq(vendors.slug, probe), ne(vendors.id, currentVendor.id)))
            .limit(1);
          if (taken.length === 0) {
            candidate = probe;
            break;
          }
          suffix++;
        }
        if (candidate !== currentVendor.slug) {
          updateData.slug = candidate;
          resolvedSlug = candidate;
        }
      }
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
    // Geolocation
    if (latitude !== undefined) updateData.latitude = latitude;
    if (longitude !== undefined) updateData.longitude = longitude;
    // Business Details
    if (yearEstablished !== undefined) updateData.yearEstablished = yearEstablished;
    if (paymentMethods) updateData.paymentMethods = JSON.stringify(paymentMethods);
    if (licenseInfo !== undefined) updateData.licenseInfo = licenseInfo;
    if (insuranceInfo !== undefined) updateData.insuranceInfo = insuranceInfo;

    await db.update(vendors).set(updateData).where(eq(vendors.userId, gate.userId));

    const updatedVendor = await db
      .select()
      .from(vendors)
      .where(eq(vendors.userId, gate.userId))
      .limit(1);

    if (updatedVendor[0]) {
      await recomputeVendorCompleteness(db, updatedVendor[0].id);
      await logEnrichment(db, {
        targetType: "vendor",
        targetId: updatedVendor[0].id,
        source: "vendor_self",
        status: "success",
        actorUserId: gate.userId,
        fieldsChanged: Object.keys(updateData),
      });
    }

    if (resolvedSlug) {
      await db.insert(vendorSlugHistory).values({
        vendorId: currentVendor.id,
        oldSlug: currentVendor.slug,
        newSlug: resolvedSlug,
        changedAt: now,
        changedBy: gate.userId,
      });
    }

    // IndexNow: ping when public-page-visible fields change. Same material
    // list as the admin route minus admin-only fields (Enhanced Profile,
    // Claimed, Verified Pro) that this self-edit surface can't touch.
    const materialChanged =
      (businessName !== undefined && businessName !== currentVendor.businessName) ||
      (vendorType !== undefined && (vendorType ?? null) !== currentVendor.vendorType) ||
      (description !== undefined && (description ?? null) !== currentVendor.description) ||
      (city !== undefined && (city ?? null) !== currentVendor.city) ||
      (state !== undefined && (state ?? null) !== currentVendor.state) ||
      (logoUrl !== undefined && (logoUrl ?? null) !== currentVendor.logoUrl) ||
      resolvedSlug !== null;
    if (materialChanged) {
      const finalSlug = resolvedSlug ?? currentVendor.slug;
      const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
      await pingIndexNow(db, indexNowUrlFor("vendors", finalSlug), env, "vendor-self-update");
    }

    return NextResponse.json(updatedVendor[0]);
  } catch (error) {
    await logError(db, {
      message: "Failed to update vendor profile",
      error,
      source: "api/vendor/profile",
      request,
    });
    return NextResponse.json({ error: "Failed to update profile" }, { status: 500 });
  }
}
