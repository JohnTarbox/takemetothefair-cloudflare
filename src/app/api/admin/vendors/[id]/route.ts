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
  contentLinks,
  blogPosts,
  recommendationItems,
} from "@/lib/db/schema";
import { eq, and, ne, inArray, gte, sql } from "drizzle-orm";
import { createSlug, appendSlugSegment, unsafeSlug, type Slug } from "@/lib/utils";
import { vendorUpdateSchema, vendorDeleteSchema, validateRequestBody } from "@/lib/validations";
import { logError } from "@/lib/logger";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";
import { getSiteUrl } from "@/lib/email/send";
import { enqueueEmail } from "@/lib/queues/producers";
import { vendorClaimConfirmationTemplate } from "@/lib/email/templates";
import { markActedAllForTarget } from "@/lib/recommendations/engine";
import { recomputeVendorCompleteness } from "@/lib/completeness";
import { logEnrichment } from "@/lib/enrichment-log";

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
        userId: vendors.userId,
        enhancedProfile: vendors.enhancedProfile,
        enhancedProfileStartedAt: vendors.enhancedProfileStartedAt,
        enhancedProfileExpiresAt: vendors.enhancedProfileExpiresAt,
        claimed: vendors.claimed,
        verifiedPro: vendors.verifiedPro,
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
              eq(vendors.slug, slugSuffix > 0 ? appendSlugSegment(slugSeed, slugSuffix) : slugSeed),
              ne(vendors.id, id)
            )
          )
          .limit(1);
        if (existingSlug.length === 0) {
          candidate = slugSuffix > 0 ? appendSlugSegment(slugSeed, slugSuffix) : slugSeed;
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
    // IMG1 §1b Phase 1 (2026-06-08) — focal point clamped.
    if (typeof data.imageFocalX === "number" && Number.isFinite(data.imageFocalX)) {
      updateData.imageFocalX = Math.max(0, Math.min(1, data.imageFocalX));
    }
    if (typeof data.imageFocalY === "number" && Number.isFinite(data.imageFocalY)) {
      updateData.imageFocalY = Math.max(0, Math.min(1, data.imageFocalY));
    }
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

    // Claimed transition (drizzle/0049). false→true grants Claimed badge,
    // sends confirmation email, logs admin action. true→false revokes.
    let claimedTransitioned: "granted" | "revoked" | null = null;
    if (data.claimed !== undefined && data.claimed !== currentVendor.claimed) {
      if (data.claimed) {
        updateData.claimed = true;
        updateData.claimedAt = now;
        updateData.claimedBy = session.user.id;
        claimedTransitioned = "granted";
      } else {
        updateData.claimed = false;
        updateData.claimedAt = null;
        updateData.claimedBy = null;
        claimedTransitioned = "revoked";
      }
    }

    // Verified Pro transition (drizzle/0052). Same shape as Claimed but
    // admin-only — no vendor email per business decision. Orthogonal to
    // Claimed: each is granted/revoked independently.
    let verifiedProTransitioned: "granted" | "revoked" | null = null;
    if (data.verified_pro !== undefined && data.verified_pro !== currentVendor.verifiedPro) {
      if (data.verified_pro) {
        updateData.verifiedPro = true;
        updateData.verifiedProAt = now;
        updateData.verifiedProBy = session.user.id;
        verifiedProTransitioned = "granted";
      } else {
        updateData.verifiedPro = false;
        updateData.verifiedProAt = null;
        updateData.verifiedProBy = null;
        verifiedProTransitioned = "revoked";
      }
    }

    // EH1 Phase 1 (drizzle/0106 + 0107) — hierarchy + relationship fields.
    // Admin-only by virtue of this route's admin-role gate at the top.
    // Vendor self-edit can set display_mode but cannot touch the other
    // seven (the gate stays with admins / brand-parent owners). See
    // resolveVendorDisplay() in src/lib/vendor-hierarchy.ts for how these
    // are consumed at render time. No transition log emitted today —
    // changes are rare and the standard enrichment log captures the
    // field-set list.
    //
    // Cycle / self-ref protection for the three FK columns: walk the
    // chain up to depth 5 via DB lookups and reject anything that would
    // either self-ref or reach back to this row. The three admin MCP
    // tools (set_vendor_relationship / set_vendor_alias) carry the same
    // checks; we duplicate here because the admin form posts straight
    // here, not through MCP.
    async function wouldFormCycle(
      column: "brand_parent_vendor_id" | "operator_parent_vendor_id" | "alias_of_vendor_id",
      targetId: string | null
    ): Promise<boolean> {
      if (targetId == null) return false;
      if (targetId === id) return true; // self-ref
      const seen = new Set<string>([id]);
      let cursor: string | null = targetId;
      for (let depth = 0; depth < 5; depth++) {
        if (cursor == null) return false;
        if (seen.has(cursor)) return true;
        seen.add(cursor);
        const [row] = await db
          .select({
            brand: vendors.brandParentVendorId,
            op: vendors.operatorParentVendorId,
            alias: vendors.aliasOfVendorId,
          })
          .from(vendors)
          .where(eq(vendors.id, cursor))
          .limit(1);
        if (!row) return false;
        // Follow the same column we're testing; cross-column chains
        // (e.g. brand_parent → alias_of) are not cycles for this column.
        cursor =
          column === "brand_parent_vendor_id"
            ? row.brand
            : column === "operator_parent_vendor_id"
              ? row.op
              : row.alias;
      }
      return true; // depth exceeded — treat as cycle
    }

    for (const [col, val] of [
      ["brand_parent_vendor_id", data.brand_parent_vendor_id],
      ["operator_parent_vendor_id", data.operator_parent_vendor_id],
      ["alias_of_vendor_id", data.alias_of_vendor_id],
    ] as const) {
      if (val !== undefined && (await wouldFormCycle(col, val))) {
        return NextResponse.json(
          { error: `Invalid ${col}: would create a cycle or self-reference` },
          { status: 400 }
        );
      }
    }

    if (data.role !== undefined) updateData.role = data.role;
    if (data.brand_parent_vendor_id !== undefined)
      updateData.brandParentVendorId = data.brand_parent_vendor_id;
    if (data.operator_parent_vendor_id !== undefined)
      updateData.operatorParentVendorId = data.operator_parent_vendor_id;
    if (data.alias_of_vendor_id !== undefined) updateData.aliasOfVendorId = data.alias_of_vendor_id;
    if (data.relationship_type !== undefined) updateData.relationshipType = data.relationship_type;
    if (data.default_child_display !== undefined)
      updateData.defaultChildDisplay = data.default_child_display;
    if (data.display_override_permitted !== undefined)
      updateData.displayOverridePermitted = data.display_override_permitted;
    if (data.display_mode !== undefined) updateData.displayMode = data.display_mode;

    await db.update(vendors).set(updateData).where(eq(vendors.id, id));

    await recomputeVendorCompleteness(db, id);

    await logEnrichment(db, {
      targetType: "vendor",
      targetId: id,
      source: "manual_admin",
      status: "success",
      actorUserId: session.user.id,
      fieldsChanged: Object.keys(updateData).filter((k) => k !== "updatedAt"),
    });

    // Slug history write — fires whenever the resolved slug actually changed,
    // regardless of whether it came from `slug` param or `businessName` rename.
    if (updateData.slug && updateData.slug !== currentVendor.slug) {
      await db.insert(vendorSlugHistory).values({
        vendorId: id,
        oldSlug: currentVendor.slug,
        newSlug: unsafeSlug(updateData.slug as string),
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

    // Audit log + email for Claimed transition.
    if (claimedTransitioned) {
      await db.insert(adminActions).values({
        action: claimedTransitioned === "granted" ? "vendor.claim_grant" : "vendor.claim_revoke",
        actorUserId: session.user.id,
        targetType: "vendor",
        targetId: id,
        payloadJson: JSON.stringify({ previous_claimed: currentVendor.claimed }),
        createdAt: now,
      });

      if (claimedTransitioned === "granted") {
        // Fire confirmation email if vendor's owner-user has an email. The
        // existing sendEmail() falls back to logging when RESEND_API_KEY is
        // unset, so this is safe in dev.
        const [ownerUser] = await db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, currentVendor.userId))
          .limit(1);
        if (ownerUser?.email) {
          const finalSlug = (updateData.slug as string | undefined) ?? currentVendor.slug;
          const tpl = vendorClaimConfirmationTemplate({
            businessName: currentVendor.businessName,
            vendorSlug: finalSlug,
            siteUrl: getSiteUrl(),
          });
          await enqueueEmail({
            to: ownerUser.email,
            ...tpl,
            source: "admin.vendor-claim-confirm",
          });
        }
      }
    }

    // Audit log for Verified Pro transition. NO email per business decision —
    // admin-only credentialing; vendor sees the badge appear next page visit.
    if (verifiedProTransitioned) {
      await db.insert(adminActions).values({
        action:
          verifiedProTransitioned === "granted"
            ? "vendor.verified_pro_grant"
            : "vendor.verified_pro_revoke",
        actorUserId: session.user.id,
        targetType: "vendor",
        targetId: id,
        payloadJson: JSON.stringify({ previous_verified_pro: currentVendor.verifiedPro }),
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
      claimedTransitioned !== null ||
      verifiedProTransitioned !== null ||
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

// Auth helper: accepts either an admin session OR a valid X-Internal-Key
// (so the MCP server can call this same route via the existing
// INTERNAL_API_KEY pattern, mirroring delete_blog_post).
async function authorizeAdminOrInternal(
  request: NextRequest
): Promise<
  { ok: true; actorUserId: string | null } | { ok: false; status: number; error: string }
> {
  const internalKey = request.headers.get("x-internal-key");
  const env = getCloudflareEnv() as unknown as { INTERNAL_API_KEY?: string };
  if (internalKey && env.INTERNAL_API_KEY && internalKey === env.INTERNAL_API_KEY) {
    return { ok: true, actorUserId: null }; // system-driven; null actor in audit log
  }
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  return { ok: true, actorUserId: session.user.id };
}

const PURGE_GRACE_DAYS = 30;
const ACTIVE_VENDOR_STATUSES = [
  "INVITED",
  "INTERESTED",
  "APPLIED",
  "WAITLISTED",
  "APPROVED",
  "CONFIRMED",
] as const;

export async function DELETE(request: NextRequest, { params }: Params) {
  const authResult = await authorizeAdminOrInternal(request);
  if (!authResult.ok) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const actorUserId = authResult.actorUserId;

  const { id } = await params;

  // Body is optional (e.g., MCP wrapper or curl with no body); default to soft-delete.
  let bodyParsed: ReturnType<typeof vendorDeleteSchema.parse>;
  try {
    const raw = await request.text();
    const json = raw ? JSON.parse(raw) : {};
    bodyParsed = vendorDeleteSchema.parse(json);
  } catch (e) {
    return NextResponse.json(
      { error: `Invalid request body: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 }
    );
  }
  const { mode, redirect_to_vendor_id, rewrite_blog_links, force, reason } = bodyParsed;

  if (force && (!reason || reason.trim().length < 10)) {
    return NextResponse.json(
      { error: "force=true requires a reason of at least 10 characters" },
      { status: 400 }
    );
  }

  const db = getCloudflareDb();
  try {
    const [vendor] = await db.select().from(vendors).where(eq(vendors.id, id)).limit(1);
    if (!vendor) {
      return NextResponse.json({ error: "Vendor not found" }, { status: 404 });
    }

    const now = new Date();

    // ─── REFUSE CHECKS ──────────────────────────────────────────────

    // 1) Active event participation: vendor has non-terminal event_vendors
    //    rows on events that have not yet ended.
    const activeEvents = await db
      .select({
        eventId: events.id,
        eventName: events.name,
        eventSlug: events.slug,
        eventStartDate: events.startDate,
        status: eventVendors.status,
      })
      .from(eventVendors)
      .innerJoin(events, eq(eventVendors.eventId, events.id))
      .where(
        and(
          eq(eventVendors.vendorId, id),
          inArray(eventVendors.status, [...ACTIVE_VENDOR_STATUSES]),
          gte(events.startDate, now)
        )
      );

    // 2) Active Enhanced Profile.
    const enhancedActive =
      vendor.enhancedProfile &&
      vendor.enhancedProfileExpiresAt !== null &&
      vendor.enhancedProfileExpiresAt.getTime() > now.getTime();

    // 3) Active user claim.
    const claimedActive = vendor.claimed === true;

    const refuseReasons: { code: string; message: string; details?: unknown }[] = [];
    if (activeEvents.length > 0) {
      refuseReasons.push({
        code: "active_event_participation",
        message: `Vendor has ${activeEvents.length} active event commitments on upcoming events. Set those to WITHDRAWN or wait for events to pass before deleting.`,
        details: activeEvents.slice(0, 10).map((e) => ({
          event_id: e.eventId,
          event_name: e.eventName,
          event_slug: e.eventSlug,
          status: e.status,
          start_date: e.eventStartDate?.toISOString() ?? null,
        })),
      });
    }
    if (enhancedActive) {
      refuseReasons.push({
        code: "active_enhanced_profile",
        message: `Vendor has active Enhanced Profile through ${vendor.enhancedProfileExpiresAt?.toISOString().slice(0, 10)}. Cancel the subscription first.`,
      });
    }
    if (claimedActive) {
      // Resolve email if possible (best-effort; falls back to "unknown")
      let email: string | null = null;
      if (vendor.userId) {
        const [u] = await db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, vendor.userId))
          .limit(1);
        email = u?.email ?? null;
      }
      refuseReasons.push({
        code: "active_claim",
        message: `Vendor is claimed${email ? ` by ${email}` : ""}. Unlink the claim first or contact the user.`,
      });
    }

    if (refuseReasons.length > 0 && !force) {
      return NextResponse.json(
        {
          deleted: false,
          vendor_id: id,
          business_name: vendor.businessName,
          refuse_reasons: refuseReasons,
        },
        { status: 409 }
      );
    }

    // ─── HARD-DELETE GUARDS ─────────────────────────────────────────

    if (mode === "hard") {
      // Allowed paths: (a) vendor is already soft-deleted ≥ grace window, or
      // (b) force=true with reason.
      const graceCutoff = new Date(now.getTime() - PURGE_GRACE_DAYS * 86400_000);
      const isPastGrace =
        vendor.deletedAt !== null && vendor.deletedAt.getTime() <= graceCutoff.getTime();
      if (!isPastGrace && !force) {
        return NextResponse.json(
          {
            error: `Hard delete requires the vendor to have been soft-deleted for at least ${PURGE_GRACE_DAYS} days, or force=true with a reason. Use mode=soft for the standard delete path.`,
          },
          { status: 409 }
        );
      }
    }

    // ─── REDIRECT-TARGET VALIDATION ─────────────────────────────────

    let redirectTarget: { id: string; slug: Slug; businessName: string } | null = null;
    if (redirect_to_vendor_id) {
      if (redirect_to_vendor_id === id) {
        return NextResponse.json(
          { error: "redirect_to_vendor_id cannot be the vendor being deleted (self-redirect)" },
          { status: 400 }
        );
      }
      const [target] = await db
        .select({
          id: vendors.id,
          slug: vendors.slug,
          businessName: vendors.businessName,
          deletedAt: vendors.deletedAt,
          redirectToVendorId: vendors.redirectToVendorId,
        })
        .from(vendors)
        .where(eq(vendors.id, redirect_to_vendor_id))
        .limit(1);
      if (!target) {
        return NextResponse.json({ error: "redirect_to_vendor_id not found" }, { status: 400 });
      }
      if (target.deletedAt !== null) {
        return NextResponse.json(
          {
            error:
              "redirect_to_vendor_id points at a soft-deleted vendor. Pick a live target. (force does not override this; it's referential integrity, not a refuse-condition.)",
          },
          { status: 400 }
        );
      }
      // Cycle prevention: target must not redirect back to this vendor.
      if (target.redirectToVendorId === id) {
        return NextResponse.json(
          { error: "Cycle detected: redirect target already redirects to this vendor" },
          { status: 400 }
        );
      }
      redirectTarget = {
        id: target.id,
        slug: target.slug,
        businessName: target.businessName,
      };
    }

    // ─── SOFT-WARNING COUNTS ────────────────────────────────────────

    const blogLinkRows = await db
      .select({
        sourceId: contentLinks.sourceId,
        sourceSlug: blogPosts.slug,
      })
      .from(contentLinks)
      .leftJoin(blogPosts, eq(contentLinks.sourceId, blogPosts.id))
      .where(and(eq(contentLinks.targetType, "VENDOR"), eq(contentLinks.targetId, id)));
    const blogPostsWithDeadLinks = Array.from(
      new Set(blogLinkRows.map((r) => r.sourceSlug).filter((s): s is Slug => !!s))
    );

    const [{ historicalCount }] = await db
      .select({ historicalCount: sql<number>`COUNT(*)` })
      .from(eventVendors)
      .where(eq(eventVendors.vendorId, id));
    const historicalEventLinksPreserved = Number(historicalCount) - activeEvents.length;

    const [{ slugHistoryCount }] = await db
      .select({ slugHistoryCount: sql<number>`COUNT(*)` })
      .from(vendorSlugHistory)
      .where(eq(vendorSlugHistory.vendorId, id));

    // ─── EXECUTE: SOFT vs HARD ──────────────────────────────────────

    const cacheInvalidatedPaths = [
      `/vendors/${vendor.slug}`,
      "/vendors",
      ...blogPostsWithDeadLinks.map((s) => `/blog/${s}`),
    ];

    if (mode === "soft") {
      // Soft delete: flip deleted_at, set redirect, migrate slug history,
      // optionally rewrite blog links, auto-resolve open recommendations,
      // audit log, IndexNow.
      await db
        .update(vendors)
        .set({
          deletedAt: now,
          redirectToVendorId: redirectTarget?.id ?? null,
          updatedAt: now,
        })
        .where(eq(vendors.id, id));

      if (redirectTarget) {
        // Insert a slug-history row mapping the deleted slug → target slug.
        await db.insert(vendorSlugHistory).values({
          vendorId: redirectTarget.id, // history rows are keyed to the LIVE vendor
          oldSlug: vendor.slug,
          newSlug: redirectTarget.slug,
          changedAt: now,
          changedBy: actorUserId,
        });
        // Re-point any pre-existing slug-history rows for the deleted vendor.
        // Walk them to the redirect target so transitive 301s still work.
        const existing = await db
          .select({ id: vendorSlugHistory.id, oldSlug: vendorSlugHistory.oldSlug })
          .from(vendorSlugHistory)
          .where(eq(vendorSlugHistory.vendorId, id));
        for (const row of existing) {
          await db
            .update(vendorSlugHistory)
            .set({
              vendorId: redirectTarget.id,
              newSlug: redirectTarget.slug,
              changedAt: now,
              changedBy: actorUserId,
            })
            .where(eq(vendorSlugHistory.id, row.id));
        }
      }

      let blogLinksRewritten = 0;
      if (rewrite_blog_links && redirectTarget && blogLinkRows.length > 0) {
        const result = await db
          .update(contentLinks)
          .set({ targetId: redirectTarget.id, targetSlug: redirectTarget.slug })
          .where(and(eq(contentLinks.targetType, "VENDOR"), eq(contentLinks.targetId, id)))
          .returning({ id: contentLinks.id });
        blogLinksRewritten = result.length;
      }

      const recommendationsResolved = await markActedAllForTarget(db, "vendor", id);

      const auditPayload = {
        mode: "soft" as const,
        business_name: vendor.businessName,
        slug: vendor.slug,
        redirect_to: redirectTarget
          ? { vendor_id: redirectTarget.id, slug: redirectTarget.slug }
          : null,
        rewrite_blog_links,
        force,
        force_reason: force ? reason : null,
        side_effect_counts: {
          blog_links_affected: blogLinkRows.length,
          blog_links_rewritten: blogLinksRewritten,
          historical_event_links_preserved: historicalEventLinksPreserved,
          slug_history_rows_redirected: Number(slugHistoryCount),
          recommendations_resolved: recommendationsResolved,
        },
        refuse_reasons_overridden: force ? refuseReasons.map((r) => r.code) : [],
      };

      const [auditRow] = await db
        .insert(adminActions)
        .values({
          action: "vendor.soft_delete",
          actorUserId,
          targetType: "vendor",
          targetId: id,
          payloadJson: JSON.stringify(auditPayload),
          createdAt: now,
        })
        .returning({ id: adminActions.id });

      const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
      await pingIndexNow(db, indexNowUrlFor("vendors", vendor.slug), env, "vendor-delete");

      return NextResponse.json({
        deleted: true,
        mode: "soft",
        vendor_id: id,
        business_name: vendor.businessName,
        redirect_to: redirectTarget,
        side_effects: {
          indexnow_pinged: true,
          sitemap_regenerated: true, // sitemap is dynamic; next request rebuilds
          cache_invalidated_paths: cacheInvalidatedPaths,
          blog_links_affected: blogLinkRows.length,
          blog_posts_with_dead_links: blogPostsWithDeadLinks,
          blog_links_rewritten: blogLinksRewritten,
          historical_event_links_preserved: historicalEventLinksPreserved,
          recommendations_resolved: recommendationsResolved,
          slug_history_rows_redirected: Number(slugHistoryCount),
        },
        audit_log_id: auditRow.id,
      });
    }

    // ─── HARD DELETE (purge) ────────────────────────────────────────

    // Capture vendor snapshot before deletion for audit log.
    const vendorSnapshot = {
      id: vendor.id,
      slug: vendor.slug,
      business_name: vendor.businessName,
      deleted_at: vendor.deletedAt?.toISOString() ?? null,
      enhanced_profile: vendor.enhancedProfile,
      claimed: vendor.claimed,
      verified_pro: vendor.verifiedPro,
    };

    // Manually delete polymorphic refs (no FK constraint to cascade).
    await db
      .delete(contentLinks)
      .where(and(eq(contentLinks.targetType, "VENDOR"), eq(contentLinks.targetId, id)));
    await db
      .delete(recommendationItems)
      .where(
        and(eq(recommendationItems.targetType, "vendor"), eq(recommendationItems.targetId, id))
      );

    // FK-cascade-deleted on the vendors row: event_vendors, vendor_claim_tokens,
    // vendor_slug_history. Other vendors with redirect_to_vendor_id pointing
    // here get SET NULL on their redirect (per migration 0053 ON DELETE policy).
    await db.delete(vendors).where(eq(vendors.id, id));

    const [auditRow] = await db
      .insert(adminActions)
      .values({
        action: "vendor.purge",
        actorUserId,
        targetType: "vendor",
        targetId: id,
        payloadJson: JSON.stringify({
          mode: "hard",
          force,
          force_reason: force ? reason : null,
          vendor_snapshot: vendorSnapshot,
          blog_links_destroyed: blogLinkRows.length,
        }),
        createdAt: now,
      })
      .returning({ id: adminActions.id });

    const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
    await pingIndexNow(db, indexNowUrlFor("vendors", vendor.slug), env, "vendor-purge");

    return NextResponse.json({
      deleted: true,
      mode: "hard",
      vendor_id: id,
      business_name: vendor.businessName,
      side_effects: {
        indexnow_pinged: true,
        sitemap_regenerated: true,
        cache_invalidated_paths: cacheInvalidatedPaths,
        blog_links_destroyed: blogLinkRows.length,
      },
      audit_log_id: auditRow.id,
    });
  } catch (error) {
    await logError(db, {
      message: "Failed to delete vendor",
      error,
      source: "api/admin/vendors/[id]:DELETE",
      request,
    });
    return NextResponse.json({ error: "Failed to delete vendor" }, { status: 500 });
  }
}
