import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { eventVendors, vendors } from "@/lib/db/schema";
import { isValidTransition } from "@/lib/vendor-status";
import { logError } from "@/lib/logger";

export const runtime = "edge";

/**
 * Vendor-initiated withdraw.
 *
 * DELETE /api/vendor/applications/[id]
 *
 * Transitions the application from its current status to WITHDRAWN if the
 * state machine allows. Soft delete by status change, not a row delete —
 * admins still need to see the record to understand drop-off patterns.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const db = getCloudflareDb();
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.userId, session.user.id),
      columns: { id: true },
    });
    if (!vendor) {
      return NextResponse.json({ error: "Vendor profile not found" }, { status: 404 });
    }

    const application = await db.query.eventVendors.findFirst({
      where: and(eq(eventVendors.id, id), eq(eventVendors.vendorId, vendor.id)),
    });

    if (!application) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 });
    }

    if (!isValidTransition(application.status, "WITHDRAWN")) {
      return NextResponse.json(
        { error: `Cannot withdraw an application in ${application.status} state.` },
        { status: 400 }
      );
    }

    await db
      .update(eventVendors)
      .set({ status: "WITHDRAWN", updatedAt: new Date() })
      .where(eq(eventVendors.id, id));

    return NextResponse.json({ ok: true, status: "WITHDRAWN" });
  } catch (error) {
    await logError(db, {
      message: "Failed to withdraw application",
      error,
      source: "api/vendor/applications/[id]:DELETE",
      request,
      context: { applicationId: id },
    });
    return NextResponse.json({ error: "Failed to withdraw application" }, { status: 500 });
  }
}
