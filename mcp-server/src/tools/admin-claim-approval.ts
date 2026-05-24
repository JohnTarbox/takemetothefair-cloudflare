/**
 * `admin_approve_vendor_claim` MCP tool — manual override for the
 * email-match + contact-email two-step claim flow.
 *
 * Background: as of Option C of the dual-role work, the claim flow
 * REQUIRES one of two proofs:
 *   1. Email-match self-service (`/api/vendor/claim/direct`):
 *      user.email_verified AND user.email == vendor.contact_email.
 *   2. Standard claim-confirmation: the confirmation email goes to
 *      `vendor.contact_email`, and the user has to click the link
 *      from that mailbox.
 *
 * Both paths fail when `vendor.contact_email` is null/empty (we have
 * no business mailbox to verify against). For those cases, this tool
 * is the escape hatch — admin can manually approve a claim after
 * out-of-band verification (phone call, in-person, business
 * registration documents, etc.).
 *
 * Audited via `admin_actions.action = 'vendor.claim_admin_approve'`
 * so the override is always traceable. Admin role required (the
 * caller's `auth.role === 'ADMIN'` check at the wrapping registration
 * function is the gate).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { adminActions, userRoles, users, vendors } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

export function registerAdminClaimApprovalTool(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "admin_approve_vendor_claim",
    "Manually approve a vendor claim that can't go through the normal email-match or contact-email flows. Used when vendors.contact_email is null/empty (no business mailbox to verify against) and the admin has verified ownership out-of-band (phone, registration docs, etc.). Sets vendors.claimed=true, transfers user_id, grants the user the VENDOR role, and writes an admin_actions audit row. Idempotent — re-running for an already-claimed vendor with the same user is a no-op. Refuses to overwrite a claim by a different user; admin must explicitly transfer first if that's the intent. Admin only.",
    {
      vendor_id: z.string().min(1).describe("ID of the vendor row to approve the claim for"),
      user_id: z
        .string()
        .min(1)
        .describe(
          "ID of the user who should own the listing after approval. Their VENDOR role will be granted via user_roles if not already present."
        ),
      reason: z
        .string()
        .min(3)
        .max(500)
        .describe(
          "Why the manual approval is happening (e.g., 'verified ownership via business registration docs on 2026-05-25'). Stored in admin_actions for audit."
        ),
    },
    async ({ vendor_id, user_id, reason }) => {
      // Verify both rows exist before touching anything. Two separate
      // queries (not joined) so the error messages can distinguish
      // which side is missing.
      const [vendor] = await db
        .select({
          id: vendors.id,
          businessName: vendors.businessName,
          slug: vendors.slug,
          userId: vendors.userId,
          claimed: vendors.claimed,
        })
        .from(vendors)
        .where(eq(vendors.id, vendor_id))
        .limit(1);
      if (!vendor) {
        return {
          content: [jsonContent({ error: "vendor_not_found", vendorId: vendor_id })],
          isError: true,
        };
      }

      const [user] = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.id, user_id))
        .limit(1);
      if (!user) {
        return {
          content: [jsonContent({ error: "user_not_found", userId: user_id })],
          isError: true,
        };
      }

      // Already-claimed-by-different-user is a hard refuse. The admin
      // would need to first explicitly un-claim or transfer, then
      // approve. This prevents accidental cross-account assignments.
      if (vendor.claimed && vendor.userId && vendor.userId !== user_id) {
        return {
          content: [
            jsonContent({
              error: "already_claimed_by_different_user",
              currentOwnerUserId: vendor.userId,
              message:
                "Vendor is already claimed by a different user. Un-claim or transfer first if reassignment is intended.",
            }),
          ],
          isError: true,
        };
      }

      // Idempotent path: already claimed by the same user. Skip the
      // mutation but write a fresh audit row noting the duplicate
      // request — admin can see they tried.
      const now = new Date();
      const wasAlreadyClaimed = vendor.claimed === true && vendor.userId === user_id;

      if (!wasAlreadyClaimed) {
        await db
          .update(vendors)
          .set({
            userId: user_id,
            claimed: true,
            claimedAt: now,
            claimedBy: user_id,
          })
          .where(eq(vendors.id, vendor_id));
      }

      // Grant VENDOR role via user_roles. Idempotent because of the
      // unique (user_id, role) index.
      await db
        .insert(userRoles)
        .values({ userId: user_id, role: "VENDOR", grantedAt: now, grantedBy: auth.userId })
        .onConflictDoNothing();

      await db.insert(adminActions).values({
        action: "vendor.claim_admin_approve",
        actorUserId: auth.userId,
        targetType: "vendor",
        targetId: vendor_id,
        payloadJson: JSON.stringify({
          via: "admin_approve_vendor_claim",
          approvedFor: { userId: user_id, email: user.email },
          reason,
          wasAlreadyClaimed,
        }),
        createdAt: now,
      });

      return {
        content: [
          jsonContent({
            ok: true,
            vendor: { id: vendor.id, slug: vendor.slug, businessName: vendor.businessName },
            grantedTo: { userId: user.id, email: user.email },
            grantedRole: "VENDOR",
            wasAlreadyClaimed,
          }),
        ],
      };
    }
  );
}
