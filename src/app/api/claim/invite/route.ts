export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import type { Database } from "@/lib/db";
import { lookupInvite } from "@/lib/claims/redeem-invite-at-signup";
import { logError } from "@/lib/logger";

/**
 * OPE-1692 — what a claim-invite link is for, so /register can say so.
 *
 * GET /api/claim/invite?token=<raw invite token>
 *   → { valid: true, entityType, entityName, entitySlug }   usable invite
 *   → { valid: false, reason: "expired" | "claimed" | "invalid", ... }
 *
 * Read-only. Never returns the invited email address. The token is a 256-bit
 * secret only its recipient holds, so the response reveals nothing a guesser
 * could reach. Never cached.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  const headers = { "Cache-Control": "no-store" };
  if (!token) return NextResponse.json({ valid: false, reason: "invalid" }, { headers });
  const db = getCloudflareDb();
  try {
    const invite = await lookupInvite(db as unknown as Database, token);
    if (!invite) return NextResponse.json({ valid: false, reason: "invalid" }, { headers });
    const base = {
      entityType: invite.entityType,
      entityName: invite.entityName,
      entitySlug: invite.entitySlug,
    };
    if (invite.expired) {
      return NextResponse.json({ valid: false, reason: "expired", ...base }, { headers });
    }
    if (invite.claimed) {
      return NextResponse.json({ valid: false, reason: "claimed", ...base }, { headers });
    }
    return NextResponse.json({ valid: true, ...base }, { headers });
  } catch (error) {
    await logError(db, {
      message: "Claim invite lookup failed",
      error,
      source: "api/claim/invite",
      request,
    });
    return NextResponse.json({ valid: false, reason: "invalid" }, { status: 500, headers });
  }
}
