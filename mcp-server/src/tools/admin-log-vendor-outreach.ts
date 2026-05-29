/**
 * `log_vendor_outreach` admin MCP tool.
 *
 * Analyst J1 (2026-05-29 PM). Lets Claude log a vendor outreach
 * attempt — same write surface as the LogOutreachButton on
 * /admin/vendor-claim-leaderboard, but callable without the browser
 * UI. Direct DB mutation (Pattern A — same as admin-claim-approval.ts),
 * since the write is simple and there's no main-app side effect we'd
 * be duplicating by going through HTTP.
 *
 * Schema is drizzle/0093 (vendor_outreach_attempts). One row per
 * attempt; outcomes update the same row in-place via a later PATCH
 * (out of scope for v1).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { vendors, vendorOutreachAttempts, adminActions } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

const CHANNEL_VALUES = ["email", "phone", "in_person", "other"] as const;
const OUTCOME_VALUES = [
  "sent",
  "opened",
  "replied",
  "claimed",
  "rejected",
  "no_response",
  "bounced",
] as const;

export function registerLogVendorOutreachTool(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "log_vendor_outreach",
    "Log an outreach attempt against a vendor. Mirrors the LogOutreachButton on /admin/vendor-claim-leaderboard. Use to record manual outreach (email sent, call made, in-person conversation) so the leaderboard stops re-suggesting an already-contacted vendor and so outcomes accumulate as a `prior_claim_outcome_signal` for future scoring. Outcome can be omitted on a freshly-opened attempt (operator logs 'I sent the email; will update when she replies') — `outcome_at` stays null until a later update. Admin only.",
    {
      vendor_id: z
        .string()
        .min(1)
        .describe("Vendor ID (UUID). Find via search_vendors or the leaderboard."),
      channel: z
        .enum(CHANNEL_VALUES)
        .describe(
          "How the outreach happened. 'in_person' for booth conversations + trade-show meetings; 'other' for catch-all (Instagram DM, etc.)."
        ),
      outcome: z
        .enum(OUTCOME_VALUES)
        .optional()
        .describe(
          "Optional. Omit when the attempt is in flight (just sent the email). sent / opened / replied / claimed / rejected / no_response / bounced. Setting outcome also sets outcome_at = now."
        ),
      notes: z
        .string()
        .max(500)
        .optional()
        .describe("Free-form notes (max 500 chars). Operator context for future reference."),
    },
    async (params) => {
      // Confirm the vendor exists before writing — clean error rather
      // than a partial FK-violation insert.
      const [vendor] = await db
        .select({ id: vendors.id, businessName: vendors.businessName })
        .from(vendors)
        .where(eq(vendors.id, params.vendor_id))
        .limit(1);
      if (!vendor) {
        return {
          content: [{ type: "text", text: `Vendor not found: ${params.vendor_id}` }],
          isError: true,
        };
      }

      const now = new Date();
      const attemptId = crypto.randomUUID();
      await db.insert(vendorOutreachAttempts).values({
        id: attemptId,
        vendorId: params.vendor_id,
        attemptStartedAt: now,
        channel: params.channel,
        outcome: params.outcome ?? null,
        outcomeAt: params.outcome ? now : null,
        notes: params.notes ?? null,
        createdBy: auth.userId,
      });

      // Audit trail so the admin_actions feed shows MCP-driven outreach
      // alongside browser-driven outreach. Same pattern as the existing
      // claim-approval tool — direct mutation + admin_actions row.
      await db.insert(adminActions).values({
        action: "vendor.outreach_logged",
        actorUserId: auth.userId,
        targetType: "vendor",
        targetId: params.vendor_id,
        payloadJson: JSON.stringify({
          attemptId,
          channel: params.channel,
          outcome: params.outcome ?? null,
          via: "mcp",
        }),
        createdAt: now,
      });

      return {
        content: [
          jsonContent({
            success: true,
            attempt_id: attemptId,
            vendor_id: params.vendor_id,
            business_name: vendor.businessName,
            channel: params.channel,
            outcome: params.outcome ?? null,
            attempt_started_at: now.toISOString(),
          }),
        ],
      };
    }
  );
}
