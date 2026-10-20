export const dynamic = "force-dynamic";
/**
 * OPE-1513 — GET / PATCH the vendor call on the signed-in promoter's own event.
 * The rules live in `@/lib/promoter/vendor-call`; this file is auth + I/O.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireVerifiedSession } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";
import { promoterVendorCallSchema, validateRequestBody } from "@/lib/validations";
import { applyPromoterVendorCall, loadPromoterVendorCall } from "@/lib/promoter/vendor-call";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const db = getCloudflareDb();
  const state = await loadPromoterVendorCall(db, session.user.id, id);
  if (!state) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  return NextResponse.json(state);
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  // OPE-703 — the same verified-email gate as every other promoter write.
  const gate = await requireVerifiedSession();
  if (!gate.ok) return gate.response;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const validation = await validateRequestBody(request, promoterVendorCallSchema);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const db = getCloudflareDb();
  try {
    const result = await applyPromoterVendorCall(db, session.user.id, id, validation.data);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ...result.state, fieldsWritten: result.fieldsWritten });
  } catch (error) {
    await logError(db, {
      message: "Failed to save promoter vendor call",
      error,
      source: "api/promoter/events/[id]/vendor-call",
      request,
    });
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
