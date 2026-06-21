/**
 * `send_vendor_email` admin MCP tool (K31, 2026-06-21).
 *
 * Compose + send a one-off transactional email from a @meetmeatthefair.com
 * address to a vendor (claim invites, missing-data outreach, replies). Sends
 * through the existing EMAIL_JOBS queue (same idempotent consumer as every
 * other transactional send), auto-BCCs jtarboxme@gmail.com, and records the
 * touch in BOTH admin_actions and vendor_outreach_attempts so the
 * claim-leaderboard stops re-suggesting an already-contacted vendor.
 *
 * BCC mechanism: the Cloudflare Email Workers binding's send() has NO bcc
 * field, so the BCC is a SECOND EMAIL_JOBS message addressed to John (source
 * 'email:vendor-bcc'). Documented here so it isn't mistaken for a real header.
 *
 * Sender note: `from` is hello@meetmeatthefair.com. The domain is a verified CF
 * Email sender; if hello@ specifically isn't yet enabled as a sender the send
 * fails LOUDLY at the consumer (logged + DLQ), never silently.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { vendors, vendorOutreachAttempts, adminActions } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

interface EmailJobMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
  source: string;
}

interface SendVendorEmailEnv {
  EMAIL_JOBS?: Queue<unknown>;
}

const PUBLIC_HOST = "https://meetmeatthefair.com";
const FROM = "Meet Me at the Fair <hello@meetmeatthefair.com>";
const BCC_TO = "jtarboxme@gmail.com";
const SIGN_OFF = "— Meet Me at the Fair";

const TEMPLATE_VALUES = ["claim_invite"] as const;
type TemplateId = (typeof TEMPLATE_VALUES)[number];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function paragraphsToHtml(text: string): string {
  return `<p>${escapeHtml(text).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
}

/** Public claim entry point — mirrors ClaimListingCTA's fallback href. */
function claimUrl(slug: string, businessName: string): string {
  return `${PUBLIC_HOST}/register?role=VENDOR&claim=${encodeURIComponent(slug)}&businessName=${encodeURIComponent(businessName)}`;
}

function buildTemplate(
  templateId: TemplateId,
  vendor: { businessName: string; slug: string }
): { subject: string; text: string; html: string } {
  switch (templateId) {
    case "claim_invite": {
      const url = claimUrl(vendor.slug, vendor.businessName);
      const text = `Hi ${vendor.businessName},

You're listed on Meet Me at the Fair — the directory connecting Maine fair- and festival-goers with the vendors they love. We built your listing from public event data, and we'd love for you to claim it (it's free).

Claiming lets you correct your details, add photos and products, and link your website so shoppers can find you:
  ${url}

There's no cost and no catch — claiming just puts you in control of how your business appears.

If you have any questions, just reply to this email.

${SIGN_OFF}`;
      return {
        subject: `Claim your free listing on Meet Me at the Fair`,
        text,
        html: paragraphsToHtml(text),
      };
    }
  }
}

export function registerSendVendorEmailTool(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: SendVendorEmailEnv
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "send_vendor_email",
    "Compose + send a one-off email from a @meetmeatthefair.com address to a vendor (claim invites, outreach for missing data, replies). Sends via the transactional email pipeline, auto-BCCs the operator, and logs to admin_actions + vendor_outreach_attempts (so the claim leaderboard stops re-suggesting the vendor). First template: 'claim_invite' — pre-filled with the vendor's free-claim URL. Requires the vendor to have a contact_email on file. Admin only.",
    {
      vendor_id: z.string().min(1).describe("Vendor ID (UUID). Find via search_vendors."),
      template_id: z
        .enum(TEMPLATE_VALUES)
        .describe("Email template. 'claim_invite' = 'you're listed; claim your free profile'."),
      vars: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Reserved for future templates that take fill-in variables. Unused by claim_invite."
        ),
    },
    async (params) => {
      if (!env?.EMAIL_JOBS) {
        return {
          content: [
            {
              type: "text",
              text: "send_vendor_email requires the EMAIL_JOBS queue binding on the MCP Worker.",
            },
          ],
          isError: true,
        };
      }

      const [vendor] = await db
        .select({
          id: vendors.id,
          businessName: vendors.businessName,
          slug: vendors.slug,
          contactEmail: vendors.contactEmail,
          claimed: vendors.claimed,
        })
        .from(vendors)
        .where(eq(vendors.id, params.vendor_id))
        .limit(1);

      if (!vendor) {
        return {
          content: [{ type: "text", text: `Vendor not found: ${params.vendor_id}` }],
          isError: true,
        };
      }
      if (!vendor.contactEmail) {
        return {
          content: [
            {
              type: "text",
              text: `Vendor ${vendor.businessName} has no contact_email on file — can't send.`,
            },
          ],
          isError: true,
        };
      }
      if (params.template_id === "claim_invite" && vendor.claimed) {
        return {
          content: [
            {
              type: "text",
              text: `Vendor ${vendor.businessName} is already claimed — a claim_invite would be confusing. Aborting.`,
            },
          ],
          isError: true,
        };
      }

      const tpl = buildTemplate(params.template_id, {
        businessName: vendor.businessName,
        slug: vendor.slug,
      });

      // Primary send to the vendor.
      const primary: EmailJobMessage = {
        to: vendor.contactEmail,
        subject: tpl.subject.slice(0, 200),
        text: tpl.text,
        html: tpl.html,
        from: FROM,
        source: "email:vendor-outreach",
      };
      await env.EMAIL_JOBS.send(primary);

      // BCC copy to the operator (CF Email send() has no bcc field — second msg).
      const bccNote = `[BCC copy] The email below was sent to ${vendor.businessName} <${vendor.contactEmail}> via send_vendor_email (${params.template_id}).\n\n----------\n\n`;
      const bcc: EmailJobMessage = {
        to: BCC_TO,
        subject: `[BCC] ${tpl.subject}`.slice(0, 200),
        text: bccNote + tpl.text,
        html: `<p>${escapeHtml(bccNote.trim())}</p>${tpl.html}`,
        from: FROM,
        source: "email:vendor-bcc",
      };
      await env.EMAIL_JOBS.send(bcc);

      const now = new Date();
      const attemptId = crypto.randomUUID();

      // Outreach attempt so the leaderboard reflects the touch.
      await db.insert(vendorOutreachAttempts).values({
        id: attemptId,
        vendorId: vendor.id,
        attemptStartedAt: now,
        channel: "email",
        outcome: "sent",
        outcomeAt: now,
        notes: `send_vendor_email: ${params.template_id}`.slice(0, 500),
        createdBy: auth.userId,
      });

      // Audit trail.
      await db.insert(adminActions).values({
        action: "vendor.email_sent",
        actorUserId: auth.userId,
        targetType: "vendor",
        targetId: vendor.id,
        payloadJson: JSON.stringify({
          template_id: params.template_id,
          to: vendor.contactEmail,
          bcc: BCC_TO,
          attemptId,
          via: "mcp",
        }),
        createdAt: now,
      });

      return {
        content: [
          jsonContent({
            success: true,
            vendor_id: vendor.id,
            business_name: vendor.businessName,
            template_id: params.template_id,
            sent_to: vendor.contactEmail,
            bcc: BCC_TO,
            outreach_attempt_id: attemptId,
          }),
        ],
      };
    }
  );
}
