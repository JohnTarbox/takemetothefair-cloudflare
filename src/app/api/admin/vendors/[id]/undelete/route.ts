// POST /api/admin/vendors/[id]/undelete — companion to the soft-delete
// path in the parent route. Clears deleted_at, preserves redirect_to_vendor_id
// (admin can clear separately if desired), regenerates sitemap entry on next
// request, IndexNow-pings so search engines re-discover.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { vendors, adminActions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { logError } from "@/lib/logger";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";

export const runtime = "edge";

interface Params {
  params: Promise<{ id: string }>;
}

async function authorizeAdminOrInternal(
  request: NextRequest
): Promise<
  { ok: true; actorUserId: string | null } | { ok: false; status: number; error: string }
> {
  const internalKey = request.headers.get("x-internal-key");
  const env = getCloudflareEnv() as unknown as { INTERNAL_API_KEY?: string };
  if (internalKey && env.INTERNAL_API_KEY && internalKey === env.INTERNAL_API_KEY) {
    return { ok: true, actorUserId: null };
  }
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  return { ok: true, actorUserId: session.user.id };
}

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await authorizeAdminOrInternal(request);
  if (!authResult.ok) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const actorUserId = authResult.actorUserId;
  const { id } = await params;

  const db = getCloudflareDb();
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
}
