export const dynamic = "force-dynamic";
/**
 * OPE-1618 — a claimed promoter imports a season of shows from one CSV / XLSX.
 * POST multipart: file, action=preview|commit, offset, rows=[row numbers].
 *
 * Only the OWNING, CLAIMED promoter: a verified session (OPE-703, same gate as
 * the create form), a promoter row linked to that user, and `claimed = true`.
 * The promoter is resolved from the session, never from the request, so a
 * promoter cannot import to anyone else's listings.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireVerifiedSession } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { promoters } from "@/lib/db/schema";
import { logError } from "@/lib/logger";
import { handleImport, readMultipart } from "@/lib/promoter-import/handle";

export async function POST(request: NextRequest) {
  const db = getCloudflareDb();
  const gate = await requireVerifiedSession();
  if (!gate.ok) return gate.response;
  try {
    const [promoter] = await db
      .select({ id: promoters.id, claimed: promoters.claimed })
      .from(promoters)
      .where(eq(promoters.userId, gate.userId))
      .limit(1);
    if (!promoter)
      return NextResponse.json({ error: "Promoter profile not found." }, { status: 404 });
    if (!promoter.claimed)
      return NextResponse.json(
        { error: "Importing is for claimed promoter listings. Claim your listing first." },
        { status: 403 }
      );
    const req = await readMultipart(request);
    if ("error" in req) return NextResponse.json({ error: req.error }, { status: 400 });
    return await handleImport(db, req, {
      promoterId: promoter.id,
      uploadedBy: gate.userId,
      channel: "portal",
    });
  } catch (error) {
    await logError(db, {
      message: "Promoter spreadsheet import failed",
      error,
      source: "api/promoter/events/import",
      request,
    });
    return NextResponse.json(
      { error: "Import failed. Nothing was saved from this request." },
      { status: 500 }
    );
  }
}
