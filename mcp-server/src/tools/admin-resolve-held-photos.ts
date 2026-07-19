/**
 * OPE-254 — `resolve_held_photos` admin tool.
 *
 * The one-shot admin resolve for held `photo-intake-unresolved` batches whose
 * fair is now known: attach each email's photos to an event's gallery and mark
 * it resolved. Shares the exact core the reply→resolve handler uses
 * (`resolveHeldPhotoEmail`); this is the tool surface for the already-stranded
 * batches whose original replies predate that handler, and for any future
 * manual recovery.
 *
 * Mirrors the internal `POST /api/admin/internal/photo-intake/resolve-held`
 * endpoint but is reachable over the MCP admin surface (mmatf_ / OAuth ADMIN),
 * so it doesn't need the X-Internal-Key.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inArray, eq } from "drizzle-orm";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { events, inboundEmails } from "../schema.js";
import { resolveHeldPhotoEmail } from "../photo/resolve-held-photos.js";
import type { GeneralPhotoEnv } from "../photo/general-photos.js";

export function registerResolveHeldPhotosTool(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: GeneralPhotoEnv
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "resolve_held_photos",
    [
      "Resolve one or more HELD photo-intake emails (reply_kind='photo-intake-unresolved')",
      "to a known event: attach each email's photos to that event's gallery",
      "(image_role=gallery — never overwrites the hero) and mark the email resolved.",
      "Idempotent: an already-resolved email is skipped; an email with no image",
      "attachments is skipped without marking resolved. Use for photos that held for",
      "lack of GPS once John has named the fair. Admin only.",
    ].join(" "),
    {
      email_ids: z
        .array(z.string().min(1))
        .min(1)
        .describe("inbound_emails.id values of the held photo-intake emails to resolve."),
      event_id: z.string().min(1).describe("Event ID (UUID) to attach the photos to."),
    },
    async (params) => {
      if (!env?.VENDOR_ASSETS || !env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
        return {
          content: [
            jsonContent({
              error:
                "resolve_held_photos requires VENDOR_ASSETS + MAIN_APP_URL + INTERNAL_API_KEY on the MCP Worker.",
            }),
          ],
          isError: true,
        };
      }

      const [eventRow] = await db
        .select({ id: events.id, name: events.name })
        .from(events)
        .where(eq(events.id, params.event_id))
        .limit(1);
      if (!eventRow) {
        return {
          content: [jsonContent({ error: `Event not found: ${params.event_id}` })],
          isError: true,
        };
      }

      const rows = await db
        .select({
          id: inboundEmails.id,
          attachmentRefs: inboundEmails.attachmentRefs,
          resultingEventId: inboundEmails.resultingEventId,
        })
        .from(inboundEmails)
        .where(inArray(inboundEmails.id, params.email_ids));
      const byId = new Map(rows.map((r) => [r.id, r]));

      const results: Array<Record<string, unknown>> = [];
      let totalAttached = 0;
      let totalFailed = 0;
      for (const id of params.email_ids) {
        const row = byId.get(id);
        if (!row) {
          results.push({ id, error: "not-found" });
          continue;
        }
        const r = await resolveHeldPhotoEmail(env, db, row, params.event_id);
        totalAttached += r.attached;
        totalFailed += r.failed;
        results.push({ id, ...r });
      }

      return {
        content: [
          jsonContent({
            eventId: params.event_id,
            eventName: eventRow.name,
            totalAttached,
            totalFailed,
            results,
          }),
        ],
      };
    }
  );
}
