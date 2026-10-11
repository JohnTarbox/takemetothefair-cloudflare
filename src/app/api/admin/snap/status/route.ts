export const dynamic = "force-dynamic";
/**
 * GET /api/admin/snap/status?ids=snap-…,snap-… — OPE-1341. What happened to each
 * snap, read from the inbound row and its photo-decision rows. ADMIN-only.
 */
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { loadSnapStatuses } from "@/lib/snap/status";

export const GET = withAuth({ role: "ADMIN" }, async ({ request, db }) => {
  const ids = (new URL(request.url).searchParams.get("ids") ?? "").split(",").filter(Boolean);
  return NextResponse.json({ statuses: await loadSnapStatuses(db, ids) });
});
