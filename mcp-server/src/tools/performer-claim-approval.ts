/**
 * OPE-116 (3/3) — performer claim approval + enhanced-profile activation.
 *
 * The performer analog of promoter-claim-approval.ts, minus the role grant:
 * userRoles.role has no PERFORMER value and there is no /performer/* portal yet,
 * so ownership is tracked purely on performers.user_id + claimed. When a portal
 * ships, a follow-up can add the role + grant.
 *
 *   - admin_approve_performer_claim: operator-driven ownership grant (used when
 *     the self-serve email-match route can't apply — e.g. a harvested act with
 *     no contact_email). Never silently overrides a claim held by a DIFFERENT
 *     user. Idempotent for the same user.
 *   - set_performer_enhanced_profile: activate/deactivate the paid Enhanced tier
 *     (mirrors set_enhanced_profile for vendors; the columns exist on performers
 *     from OPE-112). Deactivation starts a grace period (expires_at = now).
 *
 * The approvePerformerClaim core is exported for direct test drive.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { performers, users, adminActions } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

export type ApprovePerformerClaimArgs = {
  performerId: string;
  /** ID of the user who should own the performer after approval. */
  userId: string;
  /** ID of the admin/actor performing the approval (audit). */
  actorUserId: string;
  reason?: string;
};

export type ApprovePerformerClaimResult =
  | {
      ok: true;
      wasAlreadyClaimed: boolean;
      performer: { id: string; slug: string; name: string };
      grantedTo: { userId: string; email: string };
    }
  | {
      ok: false;
      error: "performer_not_found" | "user_not_found" | "already_claimed_by_different_user";
      currentOwnerUserId?: string;
      message?: string;
    };

export async function approvePerformerClaim(
  db: Db,
  { performerId, userId, actorUserId, reason }: ApprovePerformerClaimArgs
): Promise<ApprovePerformerClaimResult> {
  const [performer] = await db
    .select({
      id: performers.id,
      name: performers.name,
      slug: performers.slug,
      userId: performers.userId,
      claimed: performers.claimed,
    })
    .from(performers)
    .where(eq(performers.id, performerId))
    .limit(1);
  if (!performer) return { ok: false, error: "performer_not_found" };

  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return { ok: false, error: "user_not_found" };

  // Never overwrite a claim by a different user — surface as a dispute.
  if (performer.claimed && performer.userId && performer.userId !== userId) {
    return {
      ok: false,
      error: "already_claimed_by_different_user",
      currentOwnerUserId: performer.userId,
      message:
        "Performer is already claimed by a different user. Un-claim or transfer first if reassignment is intended.",
    };
  }

  const now = new Date();
  const wasAlreadyClaimed = performer.claimed === true && performer.userId === userId;

  if (!wasAlreadyClaimed) {
    await db
      .update(performers)
      .set({ userId, claimed: true, claimedAt: now, claimedBy: userId, updatedAt: now })
      .where(eq(performers.id, performerId));
  }

  await db.insert(adminActions).values({
    action: "performer.claim.approve",
    actorUserId,
    targetType: "performer",
    targetId: performerId,
    payloadJson: JSON.stringify({
      via: "approvePerformerClaim",
      approvedFor: { userId, email: user.email },
      reason: reason ?? null,
      wasAlreadyClaimed,
    }),
    createdAt: now,
  });

  return {
    ok: true,
    wasAlreadyClaimed,
    performer: { id: performer.id, slug: performer.slug, name: performer.name },
    grantedTo: { userId: user.id, email: user.email },
  };
}

export function registerPerformerClaimTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  // ── admin_approve_performer_claim ───────────────────────────────────────
  server.tool(
    "admin_approve_performer_claim",
    "Manually grant ownership of a performer (act) to a user — the operator path when the self-serve email-match claim can't apply (e.g. a harvested act with no contact_email). Sets performers.claimed=true, claimed_at/by, and transfers user_id. Never silently overrides a claim held by a DIFFERENT user (returns already_claimed_by_different_user). Idempotent for the same user. Writes an admin_actions audit row. Admin only.",
    {
      performer_id: z.string().min(1).describe("Performer ID (UUID)."),
      user_id: z.string().min(1).describe("ID of the user who should own the listing."),
      reason: z
        .string()
        .min(3)
        .max(500)
        .describe("Why the manual approval is happening (stored in the audit log)."),
    },
    async (params) => {
      const result = await approvePerformerClaim(db, {
        performerId: params.performer_id,
        userId: params.user_id,
        actorUserId: auth.userId,
        reason: params.reason,
      });
      return { content: [jsonContent(result)], isError: !result.ok };
    }
  );

  // ── set_performer_enhanced_profile ──────────────────────────────────────
  server.tool(
    "set_performer_enhanced_profile",
    "Activate or deactivate Enhanced Profile (paid tier) for a performer. Activation sets enhanced_profile=1, verified=1, enhanced_profile_expires_at = now + duration_days (started_at stamped once). Deactivation sets expires_at=now to start the 30-day grace period (the daily sweep flips the flag). Enhanced acts get a featured badge + social links on their public page. Admin only.",
    {
      performer_id: z.string().min(1).describe("Performer ID (UUID)."),
      active: z
        .boolean()
        .describe("true = activate; false = start grace period (no immediate flag flip)."),
      duration_days: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Activation duration in days. Default 365."),
    },
    async (params) => {
      const [performer] = await db
        .select({
          id: performers.id,
          name: performers.name,
          startedAt: performers.enhancedProfileStartedAt,
        })
        .from(performers)
        .where(eq(performers.id, params.performer_id))
        .limit(1);
      if (!performer) {
        return {
          content: [
            jsonContent({ error: "performer_not_found", performer_id: params.performer_id }),
          ],
          isError: true,
        };
      }

      const now = new Date();
      const updates: Record<string, unknown> = { updatedAt: now };
      if (params.active) {
        const durationDays = params.duration_days ?? 365;
        updates.enhancedProfile = true;
        updates.verified = true;
        updates.enhancedProfileExpiresAt = new Date(now.getTime() + durationDays * 86400000);
        if (!performer.startedAt) updates.enhancedProfileStartedAt = now;
      } else {
        // Soft-deactivate: start the grace period (sweep flips the flag later).
        updates.enhancedProfileExpiresAt = now;
      }

      await db.update(performers).set(updates).where(eq(performers.id, performer.id));

      await db.insert(adminActions).values({
        action: params.active
          ? "performer.enhanced_profile.activate"
          : "performer.enhanced_profile.deactivate",
        actorUserId: auth.userId,
        targetType: "performer",
        targetId: performer.id,
        payloadJson: JSON.stringify({
          active: params.active,
          durationDays: params.active ? (params.duration_days ?? 365) : null,
        }),
        createdAt: now,
      });

      return {
        content: [
          jsonContent({
            success: true,
            performer_id: performer.id,
            name: performer.name,
            active: params.active,
            expires_at:
              updates.enhancedProfileExpiresAt instanceof Date
                ? (updates.enhancedProfileExpiresAt as Date).toISOString()
                : null,
          }),
        ],
      };
    }
  );
}
