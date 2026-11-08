/**
 * OPE-1578 — `backfill_skipped_attachments` admin tool. See
 * ../attachments-backfill.ts. Dry-run by default.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { adminActions } from "../schema.js";
import { backfillSkippedAttachments } from "../attachments-backfill.js";

export function registerBackfillSkippedAttachmentsTool(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: { VENDOR_ASSETS?: R2Bucket }
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "backfill_skipped_attachments",
    [
      "Recover attachments an inbound email lost to the old attachment count cap, by",
      "re-opening the forwarded .eml we kept and storing each skipped part as its own",
      "attachment_refs entry. Applies the same file-safety rules as live capture and",
      "never overwrites. DRY-RUN unless commit is true. Admin only.",
    ].join(" "),
    {
      inbound_email_id: z.string().min(1).describe("inbound_emails.id to recover parts for."),
      commit: z.boolean().optional().describe("Store the parts for real. Default false."),
    },
    async (params) => {
      if (!env?.VENDOR_ASSETS) {
        return {
          content: [jsonContent({ error: "VENDOR_ASSETS binding is not available" })],
          isError: true,
        };
      }
      const result = await backfillSkippedAttachments(
        db,
        env.VENDOR_ASSETS,
        params.inbound_email_id,
        params.commit === true
      );
      if (result.committed) {
        await db.insert(adminActions).values({
          id: crypto.randomUUID(),
          action: "inbound.attachments_backfilled",
          actorUserId: auth.userId ?? null,
          targetType: "inbound_email",
          targetId: params.inbound_email_id,
          payloadJson: JSON.stringify(result.items),
          createdAt: new Date(),
        });
      }
      return { content: [jsonContent(result)] };
    }
  );
}
