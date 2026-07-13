/**
 * `send_newsletter_broadcast` admin MCP tool (OPE-190, 2026-07-13).
 *
 * A thin authenticated forwarder to the OPE-169 broadcast endpoint
 * (`POST /api/admin/newsletter/send`) so the analyst runtime can run test
 * sends + read-only previews unattended and — with an explicit human nod —
 * trigger a real broadcast. ALL send / dedup / render / ledger / issue-persist
 * logic lives server-side in that endpoint; this tool adds no new server logic,
 * only the forward + a belt-and-suspenders STOP-gate.
 *
 * STOP-gate (OPE-6) — enforced in this wrapper BEFORE the endpoint is hit:
 *   - `test_recipient` set        → allowed unattended (one-off to a seeded
 *     address is not a customer-facing broadcast).
 *   - `preview_only: true`        → allowed unattended (read-only; no send).
 *   - neither                     → a real broadcast. HARD STOP: refuse unless
 *     the caller passes `require_human_confirmation: "GO"`. The analyst runtime
 *     will only pass that string after John's explicit chat approval. This is
 *     an EXTRA gate on top of the endpoint's own NEWSLETTER_SEND_ENABLED flag.
 *
 * Auth: forwards over X-Internal-Key (the send endpoint accepts an admin
 * session OR the internal key via withAuthorized — OPE-190 extended it).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

interface Env {
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

const CONFIRM_TOKEN = "GO";

export function registerSendNewsletterBroadcastTool(
  server: McpServer,
  _db: Db,
  auth: AuthContext,
  env?: Env
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "send_newsletter_broadcast",
    [
      "Send (or preview) the newsletter via the OPE-169 broadcast endpoint. Thin",
      "forwarder — the server renders the masthead/unsubscribe footer, resolves the",
      "confirmed & non-suppressed recipient list, sends, and ledgers each message.",
      "",
      "THREE modes, gated by the STOP-gate below:",
      "• test_recipient set → one-off test send to that address only (unattended-OK).",
      "• preview_only=true → READ-ONLY pre-flight: returns the resolved recipient",
      "  list + the issue shape that WOULD be written, zero sends, zero D1 writes",
      "  (unattended-OK).",
      "• neither set → REAL BROADCAST to the whole confirmed list. HARD STOP: this",
      "  tool refuses unless you also pass require_human_confirmation:'GO', which the",
      "  analyst runtime supplies ONLY after John's explicit chat approval (OPE-6).",
    ].join(" "),
    {
      subject: z.string().min(1).max(200).describe("Email subject line."),
      content_html: z
        .string()
        .min(1)
        .describe(
          "Digest inner HTML. The endpoint wraps it in the masthead + unsubscribe footer server-side."
        ),
      content_text: z
        .string()
        .optional()
        .describe("Optional plain-text alternative; auto-derived from HTML if omitted."),
      test_recipient: z
        .string()
        .optional()
        .describe(
          "If set, send ONLY to this one address (verification). Unattended-OK — not a broadcast."
        ),
      preview_only: z
        .boolean()
        .optional()
        .describe(
          "If true, resolve + return the recipient list and issue shape WITHOUT sending or writing anything. Unattended-OK."
        ),
      require_human_confirmation: z
        .string()
        .optional()
        .describe(
          `x-human-approval-required: true. For a REAL broadcast (no test_recipient, no preview_only), this MUST equal "${CONFIRM_TOKEN}" or the send is refused. Pass it ONLY after John has explicitly approved the broadcast in chat.`
        ),
    },
    async (params) => {
      if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
        return {
          content: [{ type: "text", text: "MAIN_APP_URL or INTERNAL_API_KEY not configured." }],
          isError: true,
        };
      }

      const isPreview = params.preview_only === true;
      const isTest =
        typeof params.test_recipient === "string" && params.test_recipient.trim() !== "";
      const isRealBroadcast = !isPreview && !isTest;

      // STOP-gate: a real broadcast requires the explicit human-confirmation token.
      if (isRealBroadcast && params.require_human_confirmation !== CONFIRM_TOKEN) {
        return {
          content: [
            jsonContent({
              success: false,
              stopped: true,
              reason: "stop_gate",
              message:
                `Real broadcast to the full subscriber list requires require_human_confirmation: "${CONFIRM_TOKEN}" ` +
                "(pass it only after John's explicit approval). Or use preview_only:true / test_recipient to run unattended.",
            }),
          ],
        };
      }

      const res = await fetch(`${env.MAIN_APP_URL}/api/admin/newsletter/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-key": env.INTERNAL_API_KEY,
        },
        body: JSON.stringify({
          subject: params.subject,
          content_html: params.content_html,
          ...(params.content_text ? { content_text: params.content_text } : {}),
          ...(isTest ? { test_recipient: params.test_recipient } : {}),
          ...(isPreview ? { preview_only: true } : {}),
        }),
      });

      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || !data) {
        const errMsg =
          data && typeof data.message === "string"
            ? data.message
            : data && typeof data.error === "string"
              ? data.error
              : `HTTP ${res.status}`;
        return {
          content: [
            jsonContent({
              success: false,
              http_status: res.status,
              error: (data?.error as string) ?? "request_failed",
              message: `send_newsletter_broadcast failed: ${errMsg}`,
            }),
          ],
          isError: true,
        };
      }

      // Surface the endpoint's report verbatim (recipient count, issue slug,
      // view-in-browser URL, preview shape, etc.), tagged with the resolved mode.
      return {
        content: [
          jsonContent({
            mode: isPreview ? "preview" : isTest ? "test" : "broadcast",
            ...data,
          }),
        ],
      };
    }
  );
}
