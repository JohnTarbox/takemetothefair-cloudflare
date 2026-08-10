/**
 * OPE-191 — `send_vendor_digest`.
 *
 * The operator-facing half of the Monday vendor digest. The cron calls the same
 * endpoint unattended; this exists so the digest can be previewed and
 * test-sent BEFORE it ever reaches the vendor list — which is the ticket's
 * "verified end-to-end against a seeded test recipient" criterion, and is
 * impossible without a callable surface.
 *
 * The route owns every refusal (empty week, VENDOR_DIGEST_SEND_ENABLED,
 * test_recipient). This tool deliberately re-implements none of them: a second
 * copy of a send gate is how one of them stops being enforced.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { AuthContext } from "../auth.js";
import { mainAppFetch, type MainAppEnv } from "../main-app-fetch.js";

export function registerVendorDigestTools(server: McpServer, auth: AuthContext, env?: MainAppEnv) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "send_vendor_digest",
    [
      "OPE-191 — compose the 'New This Week' vendor digest and, depending on arguments,",
      "preview it, test-send it, or broadcast it to the vendor list.",
      "",
      "SAFE BY DEFAULT. With no arguments this reaches a real broadcast ONLY if",
      "VENDOR_DIGEST_SEND_ENABLED is 'true'; otherwise it composes and persists the issue",
      "at /newsletter/<slug> and mails nobody. Pass dry_run to write nothing at all, or",
      "test_recipient to send to exactly one address and never the list.",
      "",
      "An empty week sends nothing and reports success — that is normal, not a failure.",
      "Admin only.",
    ].join(" "),
    {
      test_recipient: z
        .string()
        .email()
        .optional()
        .describe("Send to this one address instead of the vendor list. Never touches the list."),
      dry_run: z
        .boolean()
        .optional()
        .describe("Report what would happen — no issue row written, no mail enqueued."),
    },
    async ({ test_recipient, dry_run }) => {
      let response: Response;
      try {
        response = await mainAppFetch(env ?? {}, "/api/admin/newsletter/vendor-digest", "fetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ test_recipient, dry_run }),
        });
      } catch (err) {
        return {
          content: [jsonContent({ ok: false, error: "transport", message: String(err) })],
          isError: true,
        };
      }
      const payload = await response.json().catch(() => ({ error: "unparseable_response" }));
      return response.ok
        ? { content: [jsonContent(payload)] }
        : { content: [jsonContent({ status: response.status, body: payload })], isError: true };
    }
  );
}
