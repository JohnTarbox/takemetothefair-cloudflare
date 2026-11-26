/**
 * OPE-1620 — the promoter portal's gate for API-key management. The same gate
 * as the OPE-1618 import: a verified session (OPE-703 — each route calls
 * requireVerifiedSession itself, which the OPE-238 structural test reads), a
 * promoter row linked to that user, and `claimed = true`. The promoter comes
 * from the session, never from the request.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import type { getCloudflareDb } from "@/lib/cloudflare";
import { promoters } from "@/lib/db/schema";

type Db = ReturnType<typeof getCloudflareDb>;

export async function resolveClaimedPromoter(
  db: Db,
  userId: string
): Promise<{ ok: true; promoterId: string; userId: string } | { ok: false; response: Response }> {
  const [promoter] = await db
    .select({ id: promoters.id, claimed: promoters.claimed })
    .from(promoters)
    .where(eq(promoters.userId, userId))
    .limit(1);
  if (!promoter)
    return {
      ok: false,
      response: NextResponse.json({ error: "Promoter profile not found." }, { status: 404 }),
    };
  if (!promoter.claimed)
    return {
      ok: false,
      response: NextResponse.json(
        { error: "API keys are for claimed promoter listings. Claim your listing first." },
        { status: 403 }
      ),
    };
  return { ok: true, promoterId: promoter.id, userId };
}
