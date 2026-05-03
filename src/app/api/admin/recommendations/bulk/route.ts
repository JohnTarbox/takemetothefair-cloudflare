/**
 * Bulk dismiss / mark-acted on all currently-active items for a rule.
 *
 * Use case: high-volume rules (the 50-vendor-no-description case the analyst
 * surfaced) where per-row clicking is friction. One click "Mark all done" or
 * "Snooze all 30d" on a rule group.
 *
 * Active set semantics: matches the active-list filter from getActiveItems —
 * lastSeenAt > now-7d, actedAt IS NULL, dismissedUntil expired or null. We
 * scope by ruleId so an admin can't accidentally bulk-act the wrong rule.
 *
 * Audit: a single admin_actions row with payload listing the affected count.
 * Per-item rows would balloon the audit table; the count + ruleId is enough
 * for forensics.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, gte, isNull, or, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getAuthorizedSession } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { adminActions, recommendationItems } from "@/lib/db/schema";

export const runtime = "edge";

const bodySchema = z.object({
  ruleId: z.string().min(1).max(64),
  // null = snooze forever; number = days; ignored when action=acted.
  days: z.union([z.number().int().min(1).max(365), z.null()]),
  // "acted" → set acted_at on each. "dismiss" → set dismissed_at + dismissed_until.
  action: z.enum(["acted", "dismiss"]),
  reason: z.string().max(500).optional(),
});

const ACTIVE_WINDOW_MS = 7 * 86400 * 1000;
const SNOOZE_FOREVER_DATE = new Date(8640000000000000);

export async function POST(request: Request) {
  const authz = await getAuthorizedSession(request);
  if (!authz.authorized) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

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

  const session = await auth();
  const userId = authz.userId ?? session?.user?.id ?? "internal";
  const db = getCloudflareDb();
  const now = new Date();
  const cutoff = new Date(now.getTime() - ACTIVE_WINDOW_MS);

  // Active-set predicate — must match getActiveItems' filter to avoid the
  // bulk action touching items the admin doesn't see in the UI.
  const activePredicate = and(
    eq(recommendationItems.ruleId, parsed.data.ruleId),
    gte(recommendationItems.lastSeenAt, cutoff),
    isNull(recommendationItems.actedAt),
    or(
      isNull(recommendationItems.dismissedUntil),
      sql`${recommendationItems.dismissedUntil} < ${now.getTime()}`
    )
  );

  let affected = 0;
  if (parsed.data.action === "acted") {
    const result = await db
      .update(recommendationItems)
      .set({ actedAt: now })
      .where(activePredicate);
    affected = (result as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
  } else {
    const dismissedUntil =
      parsed.data.days === null
        ? SNOOZE_FOREVER_DATE
        : new Date(now.getTime() + parsed.data.days * 86400 * 1000);
    const result = await db
      .update(recommendationItems)
      .set({
        dismissedAt: now,
        dismissedUntil,
        dismissedReason: parsed.data.reason ?? null,
      })
      .where(activePredicate);
    affected = (result as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
  }

  // Audit: one row for the bulk action. Per-item rows would balloon the table;
  // the count + ruleId is enough to retrace what happened.
  await db.insert(adminActions).values({
    id: crypto.randomUUID(),
    action:
      parsed.data.action === "acted" ? "recommendation.bulk_act" : "recommendation.bulk_dismiss",
    actorUserId: userId,
    targetType: "recommendation_rule",
    targetId: parsed.data.ruleId,
    payloadJson: JSON.stringify({
      affected,
      days: parsed.data.days,
      reason: parsed.data.reason ?? null,
    }),
    createdAt: now,
  });

  return NextResponse.json({ success: true, affected });
}
