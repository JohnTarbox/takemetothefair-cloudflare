export const dynamic = "force-dynamic";
/**
 * OPE-1620 — the promoter's own API keys (session-authed, claimed promoters only).
 * POST {name, test?} → {key_id, secret, test}: the ONLY response that ever carries the
 * secret. `test: true` (OPE-1625) makes a TEST key: it can never publish — every
 * write endpoint answers the dry-run report.
 * GET → the keys, without secrets.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCloudflareDb } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";
import { decodeHtmlEntities } from "@/lib/utils";
import { requireVerifiedSession } from "@/lib/api-auth";
import { resolveClaimedPromoter } from "@/lib/promoter-api/portal";
import { createApiKey, listApiKeys } from "@/lib/promoter-api/store";

const createSchema = z.object({
  name: z.string().trim().min(1, "Give the key a name.").max(80).transform(decodeHtmlEntities),
  test: z.boolean().optional(),
});

export async function GET() {
  const db = getCloudflareDb();
  try {
    const gate = await requireVerifiedSession();
    if (!gate.ok) return gate.response;
    const who = await resolveClaimedPromoter(db, gate.userId);
    if (!who.ok) return who.response;
    return NextResponse.json({ keys: await listApiKeys(db, who.promoterId) });
  } catch (error) {
    await logError(db, {
      message: "List promoter API keys failed",
      error,
      source: "api/promoter/api-keys",
    });
    return NextResponse.json({ error: "Could not load your keys." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const db = getCloudflareDb();
  try {
    const gate = await requireVerifiedSession();
    if (!gate.ok) return gate.response;
    const who = await resolveClaimedPromoter(db, gate.userId);
    if (!who.ok) return who.response;
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request." },
        { status: 400 }
      );
    const created = await createApiKey(db, {
      promoterId: who.promoterId,
      name: parsed.data.name,
      userId: who.userId,
      now: new Date(),
      isTest: parsed.data.test === true,
    });
    if ("error" in created) return NextResponse.json({ error: created.error }, { status: 409 });
    return NextResponse.json(
      {
        key_id: created.keyId,
        secret: created.secret,
        name: created.name,
        test: created.isTest,
        created_at: created.createdAt.toISOString(),
      },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    // Never log the secret: `created` is out of scope here by construction.
    await logError(db, {
      message: "Create promoter API key failed",
      error,
      source: "api/promoter/api-keys",
      request,
    });
    return NextResponse.json({ error: "Could not create the key." }, { status: 500 });
  }
}
