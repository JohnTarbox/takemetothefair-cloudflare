/**
 * POST /api/admin/vendors/[id]/outreach — log an outreach attempt.
 *
 * Analyst J1 (2026-05-29 PM). Surfaced by the LogOutreachButton on
 * /admin/vendor-claim-leaderboard. Schema is drizzle/0093:
 *   vendor_id, attempt_started_at, channel, outcome, outcome_at, notes,
 *   created_by.
 *
 * Auth: admin session OR X-Internal-Key header (so MCP tooling can
 * also write here without going through the admin UI).
 *
 * Outcome rules:
 *   - When outcome is provided, outcome_at = now (the operator is
 *     logging an attempt that already completed).
 *   - When outcome is null, outcome_at stays null — operator is logging
 *     "I sent it; will update when she replies." A separate PATCH route
 *     can populate the outcome later (out of scope for v1).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { vendorOutreachAttempts, vendors } from "@/lib/db/schema";
import { logError } from "@/lib/logger";
import { eq } from "drizzle-orm";

export const runtime = "edge";

const ChannelEnum = z.enum(["email", "phone", "in_person", "other"]);
const OutcomeEnum = z.enum([
  "sent",
  "opened",
  "replied",
  "claimed",
  "rejected",
  "no_response",
  "bounced",
]);

const Body = z.object({
  channel: ChannelEnum,
  outcome: OutcomeEnum.optional(),
  notes: z.string().max(500).optional(),
});

interface AuthResult {
  ok: boolean;
  actorUserId: string | null;
}

async function authorize(
  request: NextRequest,
  env: { INTERNAL_API_KEY?: string }
): Promise<AuthResult> {
  const internalKey = request.headers.get("X-Internal-Key");
  if (internalKey && env.INTERNAL_API_KEY && internalKey === env.INTERNAL_API_KEY) {
    return { ok: true, actorUserId: null };
  }
  const session = await auth();
  if (session?.user?.role === "ADMIN") {
    return { ok: true, actorUserId: session.user.id };
  }
  return { ok: false, actorUserId: null };
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const env = getCloudflareEnv() as unknown as { INTERNAL_API_KEY?: string };
  const authResult = await authorize(request, env);
  if (!authResult.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: vendorId } = await params;
  if (!vendorId) {
    return NextResponse.json({ error: "vendor id required" }, { status: 400 });
  }

  const json = await request.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const db = getCloudflareDb();
  try {
    // Confirm the vendor exists before writing — clean 404 instead of
    // a partial insert that's hard to attribute later.
    const [vendor] = await db
      .select({ id: vendors.id })
      .from(vendors)
      .where(eq(vendors.id, vendorId))
      .limit(1);
    if (!vendor) {
      return NextResponse.json({ error: "vendor not found" }, { status: 404 });
    }

    const now = new Date();
    await db.insert(vendorOutreachAttempts).values({
      vendorId,
      attemptStartedAt: now,
      channel: parsed.data.channel,
      outcome: parsed.data.outcome ?? null,
      outcomeAt: parsed.data.outcome ? now : null,
      notes: parsed.data.notes ?? null,
      createdBy: authResult.actorUserId,
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    await logError(db, {
      source: "admin:vendor-outreach:log",
      level: "error",
      message: "Failed to log vendor outreach attempt",
      error: e,
      context: { vendorId, channel: parsed.data.channel },
    });
    return NextResponse.json({ error: "Failed to log attempt" }, { status: 500 });
  }
}
