/**
 * `send_test_email` admin MCP tool (K32, 2026-06-21). Companion to K31
 * `send_vendor_email`.
 *
 * Sends a one-off TEST message through the same EMAIL_JOBS queue + template
 * engine as send_vendor_email, but with NO vendor-outreach side effects:
 *   - no `vendor_outreach_attempts` row (the claim leaderboard is untouched)
 *   - no `admin_actions` row (no audit pollution)
 *   - no vendor_id required — caller specifies the destination directly
 *
 * Use case: confirm `hello@meetmeatthefair.com` deliverability against your own
 * inbox before sending the first real claim_invite.
 *
 * The ONLY DB write that occurs is the consumer's `email_send_ledger` idempotency
 * row (keyed on the queue message id) — that is inherent to actually delivering
 * any email via the shared consumer, not a vendor/audit side effect. The subject
 * is `[TEST]`-prefixed so the test path is unmistakable in the inbox.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { AuthContext } from "../auth.js";
import { buildTemplate, TEMPLATE_VALUES, FROM } from "./admin-send-vendor-email.js";

interface EmailJobMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
  source: string;
}

interface SendTestEmailEnv {
  EMAIL_JOBS?: Queue<unknown>;
}

// Pragmatic "looks like an email" check — the consumer / CF Email binding is the
// real validator; this just rejects obvious garbage before enqueueing.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function registerSendTestEmailTool(
  server: McpServer,
  auth: AuthContext,
  env?: SendTestEmailEnv
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "send_test_email",
    [
      "Send a TEST email (via the same EMAIL_JOBS queue + templates as",
      "send_vendor_email) to a caller-specified address, with NO side effects: no",
      "vendor_outreach_attempts row, no admin_actions row, no vendor_id needed.",
      "Use it to confirm @meetmeatthefair.com deliverability to your own inbox",
      "before the first real claim_invite. Subject is [TEST]-prefixed. For",
      "claim_invite, pass vars.businessName / vars.slug to control the rendered",
      "name + claim link (they default to a placeholder vendor).",
    ].join(" "),
    {
      to_address: z.string().min(3).describe("Destination email address (e.g. your own inbox)."),
      template_id: z
        .enum(TEMPLATE_VALUES)
        .describe("Template to render — same registry as send_vendor_email."),
      vars: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Template vars. For claim_invite: businessName (default 'Test Vendor') and slug (default 'test-vendor')."
        ),
    },
    async (params) => {
      if (!env?.EMAIL_JOBS) {
        return {
          content: [{ type: "text", text: "EMAIL_JOBS binding not configured." }],
          isError: true,
        };
      }
      if (!EMAIL_RE.test(params.to_address)) {
        return {
          content: [{ type: "text", text: `Invalid to_address: ${params.to_address}` }],
          isError: true,
        };
      }

      const vars = params.vars ?? {};
      const tpl = buildTemplate(params.template_id, {
        businessName: vars.businessName ?? "Test Vendor",
        slug: vars.slug ?? "test-vendor",
      });

      const msg: EmailJobMessage = {
        to: params.to_address,
        subject: `[TEST] ${tpl.subject}`.slice(0, 200),
        text: tpl.text,
        html: tpl.html,
        from: FROM,
        source: "email:test",
      };
      await env.EMAIL_JOBS.send(msg);

      return {
        content: [
          jsonContent({
            success: true,
            sent_to: params.to_address,
            template_id: params.template_id,
            subject: msg.subject,
            no_side_effects: true,
            note: "Enqueued one EMAIL_JOBS message. No vendor_outreach_attempts or admin_actions written; the only DB row is the consumer's email_send_ledger idempotency entry.",
          }),
        ],
      };
    }
  );
}
