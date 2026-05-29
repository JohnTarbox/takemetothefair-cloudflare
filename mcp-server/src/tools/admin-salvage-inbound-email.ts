/**
 * `salvage_inbound_email` admin MCP tool.
 *
 * Thin wrapper over `POST /api/admin/inbound-emails/[id]/salvage` on the
 * main app. Mirrors the "Salvage" button at `/admin/inbound-emails` so
 * Claude can finish manual event recoveries end-to-end (link the email →
 * event_ids, fire the submitter notification, write the audit row)
 * without the operator having to drive Chrome through a NextAuth session.
 *
 * Analyst F1 (2026-05-29 backlog): driving the Item 19 salvage flow
 * through Chrome hit a `document_idle` freeze on the React modal in one
 * session. The MCP wrapper bypasses the UI surface entirely.
 *
 * Side effects on the main-app side (idempotency lives there, not here):
 *   - inbound_emails.resulting_event_id ← event_ids[0]
 *   - inbound_emails.status ← 'salvaged' (unless already replied/forwarded)
 *   - EMAIL_JOBS message to notify the submitter, gated by
 *     salvage_notified_at (idempotent across replays)
 *   - admin_actions audit row (action='inbound_email.salvaged')
 *
 * Auth: ADMIN only at the MCP layer; the underlying endpoint also
 * accepts X-Internal-Key which the wrapper forwards.
 *
 * The wrapper deliberately doesn't take a `notes` parameter even though
 * the analyst spec mentioned one — the salvage endpoint has no notes
 * field today, so adding it would silently drop the value. If we want
 * notes-on-salvage later it needs an endpoint change first; flagging
 * here so it isn't lost.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { AuthContext } from "../auth.js";

interface Env {
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

interface SalvageResponse {
  success?: boolean;
  inbound_email_id?: string;
  previous_status?: string;
  new_status?: string;
  events_linked?: string[];
  notify_outcome?: string;
  events_in_email?: number;
  error?: string;
}

export function registerSalvageInboundEmailTool(server: McpServer, auth: AuthContext, env?: Env) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "salvage_inbound_email",
    "Manually associate an inbound_email with one or more events that were created from its content, transition its status to 'salvaged' (unless already replied/forwarded), and fire the submitter notification email. Mirrors the Salvage button at /admin/inbound-emails — use this for emails the auto-pipeline couldn't handle (PDF-only attachments, multi-event landing pages, body-only fragments) once you've hand-created the events. Idempotent on the notification leg: re-running with the same event_ids will NOT re-notify (gated on salvage_notified_at). Returns the per-call outcome including notify_outcome so the caller can distinguish 'sent' from 'already-notified'. Admin only.",
    {
      inbound_email_id: z
        .string()
        .min(1)
        .describe(
          "ID of the inbound_emails row to salvage. Find these via the /admin/inbound-emails dashboard or by querying inbound_emails directly."
        ),
      event_ids: z
        .array(z.string().min(1))
        .min(1)
        .max(20)
        .describe(
          "Event IDs (UUIDs) created from this email's content, in display order — events_linked[0] becomes the 'primary' resulting_event_id. 1–20 events per call."
        ),
    },
    async (params) => {
      if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
        return {
          content: [
            jsonContent({
              error: "config",
              message:
                "salvage_inbound_email requires MAIN_APP_URL and INTERNAL_API_KEY in the MCP server environment.",
            }),
          ],
          isError: true,
        };
      }

      const url = `${env.MAIN_APP_URL}/api/admin/inbound-emails/${encodeURIComponent(
        params.inbound_email_id
      )}/salvage`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "X-Internal-Key": env.INTERNAL_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ event_ids: params.event_ids }),
        });
      } catch (e) {
        return {
          content: [
            jsonContent({
              error: "fetch_failed",
              message: `Failed to reach main app: ${e instanceof Error ? e.message : String(e)}`,
            }),
          ],
          isError: true,
        };
      }

      let parsed: SalvageResponse;
      try {
        parsed = (await response.json()) as SalvageResponse;
      } catch {
        return {
          content: [
            jsonContent({
              error: "bad_response",
              status: response.status,
              message: "Main app returned a non-JSON response.",
            }),
          ],
          isError: true,
        };
      }

      if (!response.ok || parsed.success !== true) {
        return {
          content: [
            jsonContent({
              error: parsed.error ?? "unknown",
              status: response.status,
              message: parsed.error ?? `HTTP ${response.status}`,
            }),
          ],
          isError: true,
        };
      }

      return {
        content: [
          jsonContent({
            success: true,
            inbound_email_id: parsed.inbound_email_id,
            previous_status: parsed.previous_status,
            new_status: parsed.new_status,
            events_linked: parsed.events_linked,
            notify_outcome: parsed.notify_outcome,
            events_in_email: parsed.events_in_email,
          }),
        ],
      };
    }
  );
}
