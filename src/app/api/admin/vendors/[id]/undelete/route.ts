export const dynamic = "force-dynamic";
// POST /api/admin/vendors/[id]/undelete — companion to the soft-delete
// path in the parent route. Clears deleted_at, preserves redirect_to_vendor_id
// (admin can clear separately if desired), regenerates sitemap entry on next
// request, IndexNow-pings so search engines re-discover.

import { NextResponse } from "next/server";
import { withAuthorized } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { vendors, adminActions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { logError } from "@/lib/logger";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";

// Dual auth (admin session OR X-Internal-Key, constant-time) via withAuthorized.
// The actor is the admin's user id, or null for an internal-key caller (recorded
// as such in admin_actions) — exactly withAuthorized's `userId` semantics.
export const POST = withAuthorized<{ id: string }>(async ({ request, db, userId, params }) => {
  const actorUserId = userId;
  const { id } = params;

  try {
    const [vendor] = await db.select().from(vendors).where(eq(vendors.id, id)).limit(1);
    if (!vendor) {
      return NextResponse.json({ error: "Vendor not found" }, { status: 404 });
    }
    if (vendor.deletedAt === null) {
      return NextResponse.json({ error: "Vendor is not soft-deleted" }, { status: 409 });
    }

    const now = new Date();
    await db.update(vendors).set({ deletedAt: null, updatedAt: now }).where(eq(vendors.id, id));

    const [auditRow] = await db
      .insert(adminActions)
      .values({
        action: "vendor.undelete",
        actorUserId,
        targetType: "vendor",
        targetId: id,
        payloadJson: JSON.stringify({
          previous_deleted_at: vendor.deletedAt.toISOString(),
          redirect_to_vendor_id_preserved: vendor.redirectToVendorId,
        }),
        createdAt: now,
      })
      .returning({ id: adminActions.id });

    const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
    await pingIndexNow(db, indexNowUrlFor("vendors", vendor.slug), env, "vendor-undelete");

    return NextResponse.json({
      undeleted: true,
      vendor_id: id,
      business_name: vendor.businessName,
      redirect_to_vendor_id_preserved: vendor.redirectToVendorId,
      audit_log_id: auditRow.id,
    });
  } catch (error) {
    await logError(db, {
      message: "Failed to undelete vendor",
      error,
      source: "api/admin/vendors/[id]/undelete:POST",
      request,
    });
    return NextResponse.json({ error: "Failed to undelete vendor" }, { status: 500 });
  }
});
