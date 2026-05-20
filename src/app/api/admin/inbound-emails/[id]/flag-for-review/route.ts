/**
 * POST /api/admin/inbound-emails/[id]/flag-for-review — admin toggles
 * the flagged_for_review boolean on an inbound row. Used during the
 * quarterly prompt-refinement review (spec §D.4.2) to surface rows
 * worth highlighting that aren't strictly reclassifications.
 *
 * Body: `{ flagged: boolean }`
 *
 * No inbound_email_intent_feedback row is written — this flag is a
 * separate admin annotation, not a ground-truth label. The audit row
 * lives in admin_actions like the other admin actions.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { inboundEmails, adminActions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "edge";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as { flagged?: unknown };
  if (typeof body.flagged !== "boolean") {
    return NextResponse.json({ error: "flagged (boolean) required" }, { status: 400 });
  }
  const flagged = body.flagged;

  const db = getCloudflareDb();
  const updated = await db
    .update(inboundEmails)
    .set({ flaggedForReview: flagged ? 1 : 0 })
    .where(eq(inboundEmails.id, id))
    .returning({ id: inboundEmails.id });
  if (updated.length === 0) {
    return NextResponse.json({ error: "inbound_email not found" }, { status: 404 });
  }

  await db.insert(adminActions).values({
    action: flagged ? "inbound_email.flag_for_review" : "inbound_email.unflag_review",
    actorUserId: session.user.id,
    targetType: "inbound_email",
    targetId: id,
    payloadJson: JSON.stringify({ flagged }),
    createdAt: new Date(),
  });

  return NextResponse.json({ ok: true, flagged });
}
