export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuthorized } from "@/lib/api/with-auth";
import { adminActions } from "@/lib/db/schema";
import { dismissItem, markActed } from "@/lib/recommendations/engine";

const bodySchema = z.object({
  itemId: z.string().min(1).max(64),
  // null = snooze forever; number = days
  days: z.union([z.number().int().min(1).max(365), z.null()]),
  reason: z.string().max(500).optional(),
  // When true, this is an "act" decision (item was acted on) rather than a dismiss.
  acted: z.boolean().optional(),
});

export const POST = withAuthorized(async ({ request, db, userId }) => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "invalid_json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "invalid_payload", message: parsed.error.message },
      { status: 400 }
    );
  }

  if (parsed.data.acted) {
    await markActed(db, parsed.data.itemId);
  } else {
    await dismissItem(db, parsed.data.itemId, {
      days: parsed.data.days,
      reason: parsed.data.reason,
    });
  }

  // Audit. Mirrors the enhanced-profile lifecycle pattern.
  await db.insert(adminActions).values({
    id: crypto.randomUUID(),
    action: parsed.data.acted ? "recommendation.act" : "recommendation.dismiss",
    actorUserId: userId ?? "internal",
    targetType: "recommendation_item",
    targetId: parsed.data.itemId,
    payloadJson: JSON.stringify({
      days: parsed.data.days,
      reason: parsed.data.reason ?? null,
    }),
    createdAt: new Date(),
  });

  return NextResponse.json({ success: true });
});
