/**
 * GET /api/admin/discovery-candidates — list pending discovery-candidate
 * source suggestions for admin review.
 *
 * Backs the source_suggestion Tier-3 path (drizzle/0084). When a sender
 * emails us suggesting a website as an events source AND we don't already
 * pull from it (Tier 1) AND it's not informally used (Tier 2), the
 * handler INSERTs a row here for admin to evaluate. POST → approve|reject
 * transitions status off pending_review and writes an admin_actions audit row.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { adminActions, discoveryCandidates } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";

export const runtime = "edge";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const statusFilter = request.nextUrl.searchParams.get("status") ?? "pending_review";

  const db = getCloudflareDb();
  const rows = await db
    .select()
    .from(discoveryCandidates)
    .where(eq(discoveryCandidates.status, statusFilter))
    .orderBy(desc(discoveryCandidates.createdAt))
    .limit(200);

  return NextResponse.json({
    rows: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      reviewedAt: r.reviewedAt instanceof Date ? r.reviewedAt.toISOString() : r.reviewedAt,
    })),
  });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as {
    id?: string;
    action?: "approve" | "reject";
    notes?: string;
  } | null;

  if (!body?.id || (body.action !== "approve" && body.action !== "reject")) {
    return NextResponse.json(
      { error: "id and action ('approve'|'reject') required" },
      { status: 400 }
    );
  }

  const newStatus = body.action === "approve" ? "active" : "rejected";
  const db = getCloudflareDb();
  await db
    .update(discoveryCandidates)
    .set({
      status: newStatus,
      reviewedAt: new Date(),
      reviewedByUserId: session.user.id,
      adminNotes: body.notes ?? null,
    })
    .where(eq(discoveryCandidates.id, body.id));

  await db.insert(adminActions).values({
    action: `discovery_candidate.${body.action}`,
    actorUserId: session.user.id,
    targetType: "discovery_candidate",
    targetId: body.id,
    payloadJson: JSON.stringify({ notes: body.notes ?? null }),
    createdAt: new Date(),
  });

  return NextResponse.json({ success: true, status: newStatus });
}
