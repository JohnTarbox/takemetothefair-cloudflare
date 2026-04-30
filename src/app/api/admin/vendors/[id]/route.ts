import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import {
  vendors,
  eventVendors,
  events,
  users,
  vendorSlugHistory,
  adminActions,
} from "@/lib/db/schema";
import { eq, and, ne } from "drizzle-orm";
import { createSlug } from "@/lib/utils";
import { vendorUpdateSchema, validateRequestBody } from "@/lib/validations";
import { logError } from "@/lib/logger";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";

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
    await logError(db, {
      message: "Failed to fetch vendor",
      error,
      source: "api/admin/vendors/[id]",
      request,
    });
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

  const db = getCloudflareDb();
  try {
    // Get current vendor to check if slug needs updating + capture prior values
    // for IndexNow material-change detection and audit log.
    const [currentVendor] = await db
      .select({
        slug: vendors.slug,
        businessName: vendors.businessName,
        vendorType: vendors.vendorType,
        description: vendors.description,
        city: vendors.city,
        state: vendors.state,
        enhancedProfile: vendors.enhancedProfile,
        enhancedProfileStartedAt: vendors.enhancedProfileStartedAt,
        enhancedProfileExpiresAt: vendors.enhancedProfileExpiresAt,
      })
      .from(vendors)
      .where(eq(vendors.id, id))
      .limit(1);

    if (!currentVendor) {
      return NextResponse.json({ error: "Vendor not found" }, { status: 404 });
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.businessName) {
      updateData.businessName = data.businessName;
    }

    // Slug resolution: explicit `slug` param wins over auto-generation from
    // businessName. Both paths run through the same uniqueness check and
    // both write a vendor_slug_history row when the slug actually changes.
    const slugSeed = data.slug
      ? createSlug(data.slug)
      : data.businessName
        ? createSlug(data.businessName)
        : null;

    if (slugSeed && slugSeed !== currentVendor.slug) {
      let slugSuffix = 0;
      let candidate = slugSeed;
      while (true) {
        const existingSlug = await db
          .select({ id: vendors.id })
          .from(vendors)
          .where(
            and(
              eq(vendors.slug, slugSuffix > 0 ? `${slugSeed}-${slugSuffix}` : slugSeed),
              ne(vendors.id, id)
            )
          )
          .limit(1);
        if (existingSlug.length === 0) {
          candidate = slugSuffix > 0 ? `${slugSeed}-${slugSuffix}` : slugSeed;
          break;
        }
        slugSuffix++;
      }
      if (candidate !== currentVendor.slug) {
        updateData.slug = candidate;
      }
    }
    if (data.description !== undefined) updateData.description = data.description;
    if (data.vendorType !== undefined) updateData.vendorType = data.vendorType;
    if (data.website !== undefined) updateData.website = data.website;
    if (data.logoUrl !== undefined) updateData.logoUrl = data.logoUrl;
    if (data.verified !== undefined) updateData.verified = data.verified;
    if (data.commercial !== undefined) updateData.commercial = data.commercial;
    if (data.canSelfConfirm !== undefined) updateData.canSelfConfirm = data.canSelfConfirm;
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
    if (data.paymentMethods !== undefined)
      updateData.paymentMethods = JSON.stringify(data.paymentMethods);
    if (data.licenseInfo !== undefined) updateData.licenseInfo = data.licenseInfo;
    if (data.insuranceInfo !== undefined) updateData.insuranceInfo = data.insuranceInfo;

    // Enhanced Profile fields (round-3) ----------------------------------
    // The boolean transition from off→on additionally sets verified=1 and
    // started_at as the activation timestamp; the panel/MCP usually go
    // through set_enhanced_profile but this PATCH handles direct field
    // updates and the admin UI's activate/expire buttons.
    const now = new Date();
    let enhancedProfileTransitioned: "activated" | "expire_set" | null = null;

    if (data.enhanced_profile !== undefined) {
      updateData.enhancedProfile = data.enhanced_profile;
      if (data.enhanced_profile && !currentVendor.enhancedProfile) {
        // Off→on activation: stamp started_at if first time, set 1-year expiry,
        // and flip the verified badge on automatically.
        updateData.verified = true;
        if (!currentVendor.enhancedProfileStartedAt) {
          updateData.enhancedProfileStartedAt = now;
        }
        if (!data.enhanced_profile_expires_at) {
          updateData.enhancedProfileExpiresAt = new Date(now.getTime() + 365 * 86400000);
        }
        enhancedProfileTransitioned = "activated";
      }
    }
    if (data.enhanced_profile_expires_at !== undefined) {
      const expDate = new Date(data.enhanced_profile_expires_at);
      updateData.enhancedProfileExpiresAt = expDate;
      if (expDate.getTime() <= now.getTime() && currentVendor.enhancedProfile) {
        enhancedProfileTransitioned = "expire_set";
      }
    }
    if (data.gallery_images !== undefined) {
      updateData.galleryImages = JSON.stringify(data.gallery_images);
    }
    if (data.featured_priority !== undefined) {
      updateData.featuredPriority = data.featured_priority;
    }

    await db.update(vendors).set(updateData).where(eq(vendors.id, id));

    // Slug history write — fires whenever the resolved slug actually changed,
    // regardless of whether it came from `slug` param or `businessName` rename.
    if (updateData.slug && updateData.slug !== currentVendor.slug) {
      await db.insert(vendorSlugHistory).values({
        vendorId: id,
        oldSlug: currentVendor.slug,
        newSlug: updateData.slug as string,
        changedAt: now,
        changedBy: session.user.id,
      });
    }

    // Audit log: record Enhanced Profile lifecycle transitions.
    if (enhancedProfileTransitioned) {
      await db.insert(adminActions).values({
        action:
          enhancedProfileTransitioned === "activated"
            ? "enhanced_profile.activate"
            : "enhanced_profile.expire_set",
        actorUserId: session.user.id,
        targetType: "vendor",
        targetId: id,
        payloadJson: JSON.stringify({
          previous_enhanced_profile: currentVendor.enhancedProfile,
          previous_expires_at: currentVendor.enhancedProfileExpiresAt,
        }),
        createdAt: now,
      });
    }

    const [updatedVendor] = await db.select().from(vendors).where(eq(vendors.id, id)).limit(1);

    // IndexNow: ping when fields rendered on the public vendor page change.
    // Material list expanded for round-3 to cover Enhanced Profile fields
    // since they affect what's shown publicly (gallery, badge, contact form).
    const vendorMaterialChanged =
      (data.businessName !== undefined && data.businessName !== currentVendor.businessName) ||
      (data.vendorType !== undefined && (data.vendorType ?? null) !== currentVendor.vendorType) ||
      (data.description !== undefined &&
        (data.description ?? null) !== currentVendor.description) ||
      (data.city !== undefined && (data.city ?? null) !== currentVendor.city) ||
      (data.state !== undefined && (data.state ?? null) !== currentVendor.state) ||
      data.enhanced_profile !== undefined ||
      data.gallery_images !== undefined ||
      (updateData.slug !== undefined && updateData.slug !== currentVendor.slug);
    if (vendorMaterialChanged) {
      const finalSlug = (updateData.slug as string | undefined) ?? currentVendor.slug;
      const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
      await pingIndexNow(db, indexNowUrlFor("vendors", finalSlug), env, "vendor-update");
    }

    return NextResponse.json(updatedVendor);
  } catch (error) {
    await logError(db, {
      message: "Failed to update vendor",
      error,
      source: "api/admin/vendors/[id]",
      request,
    });
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

  const db = getCloudflareDb();
  try {
    // Get vendor to find user
    const vendor = await db.select().from(vendors).where(eq(vendors.id, id)).limit(1);

    if (vendor.length > 0) {
      // Reset user role to USER
      await db.update(users).set({ role: "USER" }).where(eq(users.id, vendor[0].userId));
    }

    await db.delete(vendors).where(eq(vendors.id, id));
    return NextResponse.json({ success: true });
  } catch (error) {
    await logError(db, {
      message: "Failed to delete vendor",
      error,
      source: "api/admin/vendors/[id]",
      request,
    });
    return NextResponse.json({ error: "Failed to delete vendor" }, { status: 500 });
  }
}
