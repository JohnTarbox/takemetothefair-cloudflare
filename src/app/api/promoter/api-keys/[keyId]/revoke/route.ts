export const dynamic = "force-dynamic";
/**
 * OPE-1620 — revoke one of the session promoter's own API keys. Immediate: the
 * next request signed with it is a 401. A key of another promoter is a 404.
 */
import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";
import { requireVerifiedSession } from "@/lib/api-auth";
import { resolveClaimedPromoter } from "@/lib/promoter-api/portal";
import { revokeApiKey } from "@/lib/promoter-api/store";

export async function POST(request: Request, { params }: { params: Promise<{ keyId: string }> }) {
  const db = getCloudflareDb();
  try {
    const gate = await requireVerifiedSession();
    if (!gate.ok) return gate.response;
    const who = await resolveClaimedPromoter(db, gate.userId);
    if (!who.ok) return who.response;
    const { keyId } = await params;
    const done = await revokeApiKey(db, { promoterId: who.promoterId, keyId, now: new Date() });
    if (!done) return NextResponse.json({ error: "No such active key." }, { status: 404 });
    return NextResponse.json({ key_id: keyId, revoked: true });
  } catch (error) {
    await logError(db, {
      message: "Revoke promoter API key failed",
      error,
      source: "api/promoter/api-keys/revoke",
      request,
    });
    return NextResponse.json({ error: "Could not revoke the key." }, { status: 500 });
  }
}
