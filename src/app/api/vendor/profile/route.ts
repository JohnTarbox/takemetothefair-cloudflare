export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireVerifiedSession } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { vendors, vendorSlugHistory, adminActions, users } from "@/lib/db/schema";
import { and, eq, ne } from "drizzle-orm";
import { appendSlugSegment, createSlug, type Slug } from "@/lib/utils";
import { validateRequestBody, vendorProfileUpdateSchema } from "@/lib/validations";
import { logError } from "@/lib/logger";
import { ALWAYS_IGNORED, diffFields, recordEntityWrite } from "@/lib/audit/entity-write-log";
import { recomputeVendorCompleteness } from "@/lib/completeness";
import { logEnrichment } from "@/lib/enrichment-log";
import { indexNowUrlFor, pingIndexNow } from "@/lib/indexnow";

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

    // OPE-830 — tell the page whether edits will actually SAVE.
    //
    // Without this the form cannot know the caller is unverified until a save
    // has already been refused, which is how a vendor spent 3½ minutes filling
    // it in while every PATCH 403'd. The site-wide banner
    // (components/layout/unverified-banner) does render for these users, but
    // it says "Please verify your email" — a nag, not a consequence — and it
    // sits at the top of the page, out of sight on a 276-line form.
    //
    // Read from `users`, not from the session: the session is minted at
    // sign-in and a user who verifies mid-visit would keep a stale `false`.
    let ownerEmailVerified = true;
    try {
      const [owner] = await db
        .select({ emailVerified: users.emailVerified })
        .from(users)
        .where(eq(users.id, session.user.id))
        .limit(1);
      ownerEmailVerified = Boolean(owner?.emailVerified);
    } catch {
      // ⚠️ Fail OPEN — assume verified. A DB hiccup must not put a scary
      // "your edits will not save" notice in front of a verified vendor. The
      // PATCH gate is the real enforcement; this field only drives copy.
      ownerEmailVerified = true;
    }

    return NextResponse.json({ ...vendor[0], ownerEmailVerified });
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
  if (!gate.ok) {
    // OPE-830 — record the refusal.
    //
    // This return sits ABOVE every log call in the route, so until now a
    // rejected save left no trace anywhere: `enrichment_log` records
    // successes only, and nothing else fired. That is what made two live
    // "my profile won't save" reports unanswerable — "no record of a save"
    // and "no save was attempted" were the same observation.
    //
    // The specimen: a vendor uploaded a photo at 21:47:53 (which passes on
    // the session-only gate) and verified his email at 21:51:18. Whether he
    // typed into the form during those 3½ minutes is precisely what nothing
    // could say. It can now.
    if (gate.reason !== "unauthenticated" && gate.userId) {
      const [refused] = await db
        .select({ id: vendors.id })
        .from(vendors)
        .where(eq(vendors.userId, gate.userId))
        .limit(1);
      if (refused) {
        await recordEntityWrite(db, {
          entityType: "vendor",
          entityId: refused.id,
          source: "vendor_self",
          actorUserId: gate.userId,
          rejectReason: gate.reason === "email_unverified" ? "email_unverified" : "forbidden",
        });
      }
    }
    return gate.response;
  }

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
      displayMode,
      displayName,
    } = validation.data;

    // Snapshot current vendor for slug-change detection, slug history,
    // and IndexNow material-change comparison. Mirrors the admin PATCH at
    // src/app/api/admin/vendors/[id]/route.ts — keeping the self-edit
    // surface in parity so renames don't silently break branded URLs.
    // EH1 Phase 1: also reads `role` for the displayMode gate below.
    // ⚠️ OPE-830 — full row, not a column subset.
    //
    // This was a 12-column select. A before/after diff can only report the
    // fields it can see, and a partial snapshot would silently report every
    // unselected column as unchanged — the same class of blind spot as the
    // `fields_changed` this replaces. The row is small and already fetched
    // once per request; widening it costs nothing and removes the trap.
    const [currentVendor] = await db
      .select()
      .from(vendors)
      .where(eq(vendors.userId, gate.userId))
      .limit(1);

    if (!currentVendor) {
      return NextResponse.json({ error: "Vendor profile not found" }, { status: 404 });
    }

    // EH1 Phase 1 — displayMode gate. Only LOCAL_OFFICE rows can self-edit
    // this field (it expresses a child's request; whether it's honored at
    // render still depends on the brand parent's displayOverridePermitted
    // gate, which remains admin/brand-parent-owner only). Non-LOCAL_OFFICE
    // callers get a clear 400 instead of a silent no-op so the UI can
    // surface the rule.
    if (displayMode !== undefined && currentVendor.role !== "LOCAL_OFFICE") {
      return NextResponse.json(
        {
          error:
            "displayMode can only be set on LOCAL_OFFICE vendors. " +
            "Contact the national brand to convert this listing into a local office.",
        },
        { status: 400 }
      );
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
    // EH1 Phase 1 — pre-validated above (only LOCAL_OFFICE callers reach
    // this assignment). Safe to set unconditionally when present.
    if (displayMode !== undefined) updateData.displayMode = displayMode;
    // A5 — public display-name alias. Benign self-edit on the owner's own row
    // (no hierarchy gate); COALESCE(display_name, business_name) at render.
    if (displayName !== undefined) updateData.displayName = displayName;

    // A5 — detect a real displayMode preference change so we can write a
    // discrete audit row (mirrors the admin claim/verified-pro audit pattern).
    // We compare against the snapshot rather than just "key present" so a
    // no-op resubmit doesn't spam the audit log.
    const displayModeChanged =
      displayMode !== undefined && displayMode !== currentVendor.displayMode;

    await db.update(vendors).set(updateData).where(eq(vendors.userId, gate.userId));

    if (displayModeChanged) {
      // vendor.display_preference_change — the office expressing/altering its
      // requested display mode. `override_currently_granted` records whether
      // this preference is actually honored publicly right now (the parent's
      // display_override_permitted gate); false means it's stored-but-inert
      // until the brand grants override. Counterpart to the admin-side
      // `vendor.gate_change` row (api/admin/vendors/[id]/route.ts).
      await db.insert(adminActions).values({
        action: "vendor.display_preference_change",
        actorUserId: gate.userId,
        targetType: "vendor",
        targetId: currentVendor.id,
        payloadJson: JSON.stringify({
          previous_display_mode: currentVendor.displayMode,
          new_display_mode: displayMode,
          override_currently_granted: Boolean(currentVendor.displayOverridePermitted),
          source: "vendor_self",
        }),
        createdAt: now,
      });
    }

    const updatedVendor = await db
      .select()
      .from(vendors)
      .where(eq(vendors.userId, gate.userId))
      .limit(1);

    if (updatedVendor[0]) {
      await recomputeVendorCompleteness(db, updatedVendor[0].id);
      // ⚠️ `fieldsChanged` here is `Object.keys(updateData)` — the fields
      // PRESENT in the payload, not the ones that changed. It is byte-identical
      // across all 18 saves on the OPE-830 specimen and would be identical on a
      // no-op resubmit. Left as-is because coverage dashboards read this column
      // and its meaning, though badly named, is stable; the real diff goes to
      // entity_write_log below. Do not "fix" this in place without checking
      // those readers first.
      await logEnrichment(db, {
        targetType: "vendor",
        targetId: updatedVendor[0].id,
        source: "vendor_self",
        status: "success",
        actorUserId: gate.userId,
        fieldsChanged: Object.keys(updateData),
      });

      // OPE-830 — what this save actually did.
      //
      // Diffed against the pre-update row, so a resubmit records `noop` with
      // an empty change list rather than looking identical to a real edit.
      await recordEntityWrite(db, {
        entityType: "vendor",
        entityId: updatedVendor[0].id,
        source: "vendor_self",
        actorUserId: gate.userId,
        changes: diffFields(currentVendor as unknown as Record<string, unknown>, updateData, {
          ignore: ALWAYS_IGNORED,
        }),
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
