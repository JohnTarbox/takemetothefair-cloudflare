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
 * test_recipient, and OPE-862's human-confirmation token). This tool
 * deliberately re-implements none of them: a second copy of a send gate is how
 * one of them stops being enforced.
 *
 * OPE-862 — that principle held, and the gate it was protecting did not exist.
 * `send_newsletter_broadcast` refused a real broadcast without an operator
 * token; this tool reached the same vendor list with no arguments at all, and
 * on 2026-09-09 it did. The token now lives in @takemetothefair/constants and
 * is enforced in the route, so this file still re-implements nothing — it just
 * has one more argument to hand over.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { AuthContext } from "../auth.js";
import { mainAppFetch, type MainAppEnv } from "../main-app-fetch.js";
import { BROADCAST_CONFIRM_TOKEN } from "@takemetothefair/constants";

export function registerVendorDigestTools(server: McpServer, auth: AuthContext, env?: MainAppEnv) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "send_vendor_digest",
    [
      "OPE-191 — compose the 'New This Week' vendor digest and, depending on arguments,",
      "preview it, test-send it, or broadcast it to the vendor list.",
      "",
      "SAFE BY DEFAULT. With no arguments this NEVER broadcasts: a real send to the vendor",
      "list requires BOTH VENDOR_DIGEST_SEND_ENABLED='true' AND",
      `require_human_confirmation:'${BROADCAST_CONFIRM_TOKEN}' (OPE-862). Without the token it`,
      "composes and persists the issue at /newsletter/<slug> and mails nobody. Pass dry_run to",
      "write nothing at all, or test_recipient to send to exactly one address and never the list.",
      "",
      "OPE-866 — test_recipient is now a ZERO-WRITE mode: it mails one address and writes no",
      "newsletter_issues row, so it no longer publishes a /newsletter/<slug> page as a side",
      "effect. It ledgers under a distinct ':test' source so a preview can be told apart from a",
      "real broadcast in one query.",
      "",
      "An empty week sends nothing and reports success — that is normal, not a failure.",
      "Admin only.",
    ].join(" "),
    {
      test_recipient: z
        .string()
        .email()
        .optional()
        .describe(
          "Send to this one address instead of the vendor list. Never touches the list, and " +
            "writes nothing (OPE-866) — no issue row, no public page."
        ),
      dry_run: z
        .boolean()
        .optional()
        .describe("Report what would happen — no issue row written, no mail enqueued."),
      require_human_confirmation: z
        .string()
        .optional()
        .describe(
          `OPE-862 — x-human-approval-required: true. For a REAL broadcast to the vendor list ` +
            `(no test_recipient, no dry_run) this MUST equal "${BROADCAST_CONFIRM_TOKEN}" or the ` +
            `send is withheld and the issue is only composed for review. Pass it ONLY after John ` +
            `has explicitly approved this broadcast in chat.`
        ),
    },
    async ({ test_recipient, dry_run, require_human_confirmation }) => {
      let response: Response;
      try {
        response = await mainAppFetch(env ?? {}, "/api/admin/newsletter/vendor-digest", "fetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ test_recipient, dry_run, require_human_confirmation }),
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
