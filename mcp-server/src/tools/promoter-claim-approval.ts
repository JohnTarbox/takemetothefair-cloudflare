/**
 * Promoter claim-approval core — OPE-63.
 *
 * The promoter analog of the vendor path in admin-claim-approval.ts. This is the
 * reusable, side-effecting core (no MCP wiring): approves a user's claim on a
 * promoter, granting ownership + the PROMOTER role and writing an audit row.
 * The MCP tool wrapper that exposes this to operators is OPE-67 — this file only
 * ships the callable core so the wizard/queue tickets can encode against it.
 *
 * Invariant (never overwrite): if the promoter is already `claimed` by a
 * DIFFERENT user, this refuses (returns a dispute error) rather than reassigning.
 * Idempotent for the same user: re-running is a no-op flip but still grants the
 * role (onConflictDoNothing) and writes a fresh audit row noting the duplicate.
 */
import { eq } from "drizzle-orm";
import { adminActions, promoters, userRoles, users } from "../schema.js";
import type { Db } from "../db.js";

export type ApprovePromoterClaimArgs = {
  promoterId: string;
  /** ID of the user who should own the promoter after approval. */
  userId: string;
  /** ID of the admin/actor performing the approval (audit + granted_by). */
  actorUserId: string;
  /** Optional free-text reason, stored in the admin_actions audit payload. */
  reason?: string;
};

export type ApprovePromoterClaimResult =
  | {
      ok: true;
      wasAlreadyClaimed: boolean;
      promoter: { id: string; slug: string; companyName: string };
      grantedTo: { userId: string; email: string };
      grantedRole: "PROMOTER";
    }
  | {
      ok: false;
      error: "promoter_not_found" | "user_not_found" | "already_claimed_by_different_user";
      currentOwnerUserId?: string;
      message?: string;
    };

export async function approvePromoterClaim(
  db: Db,
  { promoterId, userId, actorUserId, reason }: ApprovePromoterClaimArgs
): Promise<ApprovePromoterClaimResult> {
  // Verify both rows exist before touching anything. Two separate queries (not
  // joined) so the error can distinguish which side is missing.
  const [promoter] = await db
    .select({
      id: promoters.id,
      companyName: promoters.companyName,
      slug: promoters.slug,
      userId: promoters.userId,
      claimed: promoters.claimed,
    })
    .from(promoters)
    .where(eq(promoters.id, promoterId))
    .limit(1);
  if (!promoter) {
    return { ok: false, error: "promoter_not_found" };
  }

  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) {
    return { ok: false, error: "user_not_found" };
  }

  // Never overwrite a claim by a different user. Keep the invariant — the
  // operator must explicitly un-claim / transfer first if reassignment is
  // intended. Surface it as a dispute rather than silently clobbering.
  if (promoter.claimed && promoter.userId && promoter.userId !== userId) {
    return {
      ok: false,
      error: "already_claimed_by_different_user",
      currentOwnerUserId: promoter.userId,
      message:
        "Promoter is already claimed by a different user. Un-claim or transfer first if reassignment is intended.",
    };
  }

  const now = new Date();
  const wasAlreadyClaimed = promoter.claimed === true && promoter.userId === userId;

  if (!wasAlreadyClaimed) {
    await db
      .update(promoters)
      .set({
        userId,
        claimed: true,
        claimedAt: now,
        claimedBy: userId,
      })
      .where(eq(promoters.id, promoterId));
  }

  // Grant the PROMOTER role. Idempotent via the unique (user_id, role) index.
  await db
    .insert(userRoles)
    .values({ userId, role: "PROMOTER", grantedAt: now, grantedBy: actorUserId })
    .onConflictDoNothing();

  await db.insert(adminActions).values({
    action: "promoter.claim.approve",
    actorUserId,
    targetType: "promoter",
    targetId: promoterId,
    payloadJson: JSON.stringify({
      via: "approvePromoterClaim",
      approvedFor: { userId, email: user.email },
      reason: reason ?? null,
      wasAlreadyClaimed,
    }),
    createdAt: now,
  });

  return {
    ok: true,
    wasAlreadyClaimed,
    promoter: { id: promoter.id, slug: promoter.slug, companyName: promoter.companyName },
    grantedTo: { userId: user.id, email: user.email },
    grantedRole: "PROMOTER",
  };
}
