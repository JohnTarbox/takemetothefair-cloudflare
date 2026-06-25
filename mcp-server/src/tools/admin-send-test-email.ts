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
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import {
  applyCanSpamFooter,
  isEmailSuppressed,
  renderEmailBody,
  TEMPLATE_VALUES,
  FROM,
  type SendVendorEmailEnv,
} from "./admin-send-vendor-email.js";

interface EmailJobMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
  source: string;
}

// Pragmatic "looks like an email" check — the consumer / CF Email binding is the
// real validator; this just rejects obvious garbage before enqueueing.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function registerSendTestEmailTool(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: SendVendorEmailEnv
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "send_test_email",
    [
      "Send a TEST email (via the same EMAIL_JOBS queue + render path as",
      "send_vendor_email) to a caller-specified address, with NO side effects: no",
      "vendor_outreach_attempts row, no admin_actions row, no vendor_id needed.",
      "Render a template (claim_invite) OR send free-form via subject + body.",
      "Honors the suppression list and appends the CAN-SPAM footer, so it tests",
      "the REAL outbound shape. Subject is [TEST]-prefixed. Use it to confirm",
      "@meetmeatthefair.com deliverability before the first real claim_invite.",
    ].join(" "),
    {
      to_address: z.string().min(3).describe("Destination email address (e.g. your own inbox)."),
      template_id: z
        .enum(TEMPLATE_VALUES)
        .optional()
        .describe("Template to render — same registry as send_vendor_email. Omit for free-form."),
      subject: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Free-form subject (provide with `body` instead of template_id)."),
      body: z.string().min(1).optional().describe("Free-form plain-text body."),
      html: z.string().optional().describe("Optional free-form HTML body."),
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

      const freeForm = !!(params.subject && params.body);
      if (!freeForm && !params.template_id) {
        return {
          content: [
            {
              type: "text",
              text: "Provide either template_id (e.g. claim_invite) or a free-form subject + body.",
            },
          ],
          isError: true,
        };
      }

      // K36 — honor the suppression list even on the test path (it's a real
      // send). No DB writes either way: side-effect-free is preserved.
      if (await isEmailSuppressed(db, params.to_address)) {
        return {
          content: [
            jsonContent({
              success: false,
              suppressed: true,
              sent_to: params.to_address,
              note: "Address is on the suppression list (unsubscribed). Nothing was sent.",
            }),
          ],
        };
      }

      const vars = params.vars ?? {};
      const rendered = await applyCanSpamFooter(
        renderEmailBody({
          templateId: params.template_id,
          vendor: {
            businessName: vars.businessName ?? "Test Vendor",
            slug: vars.slug ?? "test-vendor",
          },
          subject: params.subject,
          body: params.body,
          html: params.html,
        }),
        {
          recipientEmail: params.to_address,
          reasonLine: "this is a deliverability test you triggered from Meet Me at the Fair.",
          env,
        }
      );

      const msg: EmailJobMessage = {
        to: params.to_address,
        subject: `[TEST] ${rendered.subject}`.slice(0, 200),
        text: rendered.text,
        html: rendered.html,
        from: FROM,
        source: "email:test",
      };
      await env.EMAIL_JOBS.send(msg);

      return {
        content: [
          jsonContent({
            success: true,
            sent_to: params.to_address,
            mode: freeForm ? "free-form" : (params.template_id as string),
            template_id: params.template_id ?? null,
            subject: msg.subject,
            no_side_effects: true,
            note: "Enqueued one EMAIL_JOBS message. No vendor_outreach_attempts or admin_actions written; the only DB row is the consumer's email_send_ledger idempotency entry.",
          }),
        ],
      };
    }
  );
}
