/**
 * OPE-469 — `replay_inbound_attachment` admin tool.
 *
 * The tool surface for `replayInboundAttachment`. Every attachment we have ever
 * received is retained but, until now, none of it could be re-processed: the
 * two tools that touch stored emails (`resolve_held_photos`,
 * `salvage_inbound_email`) are repair tools that take the answer as INPUT, so
 * neither exercises extraction. The only end-to-end test of the photo lane was
 * for an operator to attend a fair and take a picture.
 *
 * Dry-run by default, and the default is not a convenience — this reads live
 * rows, and a replay that wrote by default would turn a regression corpus into
 * a data-corruption vector.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { replayInboundAttachment, type ReplayEnv } from "../photo/replay.js";

export function registerReplayInboundAttachmentTool(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: ReplayEnv & { REPLAY_COMMIT_ENABLED?: string }
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "replay_inbound_attachment",
    [
      "Re-feed a stored inbound attachment through the photo pipeline exactly as a",
      "live inbound would go through it — same bytes, same vision model, same fair",
      "resolution — and report what it WOULD write, without writing.",
      "DRY-RUN BY DEFAULT. Committing additionally requires REPLAY_COMMIT_ENABLED='true'",
      "on the Worker, so a commit cannot happen by passing an argument alone.",
      "Never sends mail: it returns a report, not a reply kind, so there is no value",
      "for the workflow's send step to act on.",
      "Use it to test the photo lane against retained originals instead of attending a fair,",
      "and to diagnose why a given email stored nothing. Admin only.",
    ].join(" "),
    {
      inbound_email_id: z
        .string()
        .min(1)
        .describe("inbound_emails.id of the email whose attachments should be replayed."),
      attachment_index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("0-based index into this email's IMAGE attachments. Omit to replay all of them."),
      commit: z
        .boolean()
        .optional()
        .describe(
          "Write the outcome for real. Also requires REPLAY_COMMIT_ENABLED='true'; " +
            "without it the call still runs and the report says why nothing was written."
        ),
    },
    async (params) => {
      if (!env?.VENDOR_ASSETS) {
        return {
          content: [
            jsonContent({
              error:
                "replay_inbound_attachment requires the VENDOR_ASSETS R2 binding on the MCP Worker — " +
                "the stored originals live there.",
            }),
          ],
          isError: true,
        };
      }

      try {
        const report = await replayInboundAttachment(env, db, {
          inboundEmailId: params.inbound_email_id,
          attachmentIndex: params.attachment_index,
          commit: params.commit,
        });
        return { content: [jsonContent(report)] };
      } catch (e) {
        // A missing email or an out-of-range index is operator error and should
        // read as such. An unresolved fair or a disabled vision model is NOT an
        // error — those come back inside the report, because they are the
        // answers a replay is usually run to get.
        return {
          content: [jsonContent({ error: e instanceof Error ? e.message : String(e) })],
          isError: true,
        };
      }
    }
  );
}
