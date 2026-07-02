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
import { desc, eq } from "drizzle-orm";
import { vendors, vendorOutreachAttempts, adminActions, emailSuppressionList } from "../schema.js";
import { jsonContent } from "../helpers.js";
import { buildUnsubscribeUrl } from "@takemetothefair/utils";
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

// K36 — footer/unsubscribe needs the shared HMAC secret + (optional) override
// mailing address. INTERNAL_API_KEY is the default token-signing key (both this
// Worker and the main-app /unsubscribe route hold it). Exported shape reused by
// send_test_email.
export interface SendVendorEmailEnv {
  EMAIL_JOBS?: Queue<unknown>;
  INTERNAL_API_KEY?: string;
  UNSUBSCRIBE_SECRET?: string;
  MAILING_ADDRESS?: string;
}

const PUBLIC_HOST = "https://meetmeatthefair.com";
// Exported so the K32 send_test_email tool sends from the SAME verified sender.
export const FROM = "Meet Me at the Fair <hello@meetmeatthefair.com>";
const BCC_TO = "jtarboxme@gmail.com";
const SIGN_OFF = "— Meet Me at the Fair";

// K36 — CAN-SPAM §5(a)(5) physical postal address. OPERATOR ACTION REQUIRED:
// set the real mailing address via the MAILING_ADDRESS secret on the MCP Worker
// before sending real outbound mail at volume. The placeholder is intentionally
// obvious so an un-set deploy is caught in review/inbox, not silently shipped.
const DEFAULT_MAILING_ADDRESS = "Meet Me at the Fair, [MAILING_ADDRESS not set]";

/** The HMAC key for unsubscribe tokens — dedicated secret if set, else the shared internal key. */
function unsubscribeSecret(env?: SendVendorEmailEnv): string {
  return env?.UNSUBSCRIBE_SECRET || env?.INTERNAL_API_KEY || "";
}

// Exported so K32 (send_test_email) shares this single template registry.
export const TEMPLATE_VALUES = ["claim_invite"] as const;
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

// Exported so K32 (send_test_email) renders via the SAME engine — a synthetic
// vendor built from `vars` stands in for a real row on the test path.
export function buildTemplate(
  templateId: TemplateId,
  vendor: { businessName: string; slug: string }
): { subject: string; text: string; html: string } {
  switch (templateId) {
    case "claim_invite": {
      const url = claimUrl(vendor.slug, vendor.businessName);
      const text = `Hi ${vendor.businessName},

You're listed on Meet Me at the Fair — the New England directory connecting fair-, festival-, and craft-show-goers across all six states with the vendors they love. We built your listing from public event data, and we'd love for you to claim it (it's free).

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

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * K41 — render either a registered template OR a free-form subject+body. When
 * `subject` and `body` are supplied they win (free-form); otherwise the
 * `templateId`+`vendor` template is rendered. Footer is NOT applied here —
 * callers add it via {@link applyCanSpamFooter} once the recipient is known.
 */
export function renderEmailBody(input: {
  templateId?: TemplateId;
  vendor?: { businessName: string; slug: string };
  subject?: string;
  body?: string;
  html?: string;
}): RenderedEmail {
  if (input.subject && input.body) {
    return {
      subject: input.subject,
      text: input.body,
      html: input.html ?? paragraphsToHtml(input.body),
    };
  }
  if (input.templateId && input.vendor) {
    return buildTemplate(input.templateId, input.vendor);
  }
  throw new Error("renderEmailBody needs subject+body (free-form) or templateId+vendor (template)");
}

/**
 * K36 — append the CAN-SPAM footer (working one-click unsubscribe link,
 * physical mailing address, "you're receiving this because…" line) to both the
 * text and HTML bodies. Async because the unsubscribe link carries an HMAC
 * token over the recipient address.
 */
export async function applyCanSpamFooter(
  rendered: RenderedEmail,
  opts: { recipientEmail: string; reasonLine: string; env?: SendVendorEmailEnv }
): Promise<RenderedEmail> {
  const mailingAddress = opts.env?.MAILING_ADDRESS || DEFAULT_MAILING_ADDRESS;
  const unsubscribeUrl = await buildUnsubscribeUrl(
    PUBLIC_HOST,
    unsubscribeSecret(opts.env),
    opts.recipientEmail
  );

  const footerText = `\n\n--\nYou're receiving this because ${opts.reasonLine}\nUnsubscribe: ${unsubscribeUrl}\nMeet Me at the Fair · ${mailingAddress}`;
  const footerHtml = `<hr style="margin-top:24px;border:none;border-top:1px solid #ddd"><p style="font-size:12px;color:#666;line-height:1.5">You're receiving this because ${escapeHtml(opts.reasonLine)}<br><a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a> · Meet Me at the Fair · ${escapeHtml(mailingAddress)}</p>`;

  return {
    subject: rendered.subject,
    text: rendered.text + footerText,
    html: rendered.html + footerHtml,
  };
}

/**
 * K36 — has this address opted out? Lowercased lookup against the suppression
 * list. Solicited sends (vendor outreach, free-form, test) must skip a match;
 * transactional/system mail does NOT call this.
 */
export async function isEmailSuppressed(db: Db, email: string): Promise<boolean> {
  const [row] = await db
    .select({ email: emailSuppressionList.email })
    .from(emailSuppressionList)
    .where(eq(emailSuppressionList.email, email.trim().toLowerCase()))
    .limit(1);
  return !!row;
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
    "Compose + send a one-off email from a @meetmeatthefair.com address to a vendor (claim invites, outreach for missing data, replies). Either render a template ('claim_invite') OR send FREE-FORM by passing subject + body (+ optional html). Sends via the transactional email pipeline, auto-BCCs the operator, appends a CAN-SPAM footer (unsubscribe + mailing address), honors the suppression list (returns suppressed:true and sends nothing if the vendor unsubscribed), and logs to admin_actions + vendor_outreach_attempts. Requires the vendor to have a contact_email on file. Admin only.",
    {
      vendor_id: z.string().min(1).describe("Vendor ID (UUID). Find via search_vendors."),
      template_id: z
        .enum(TEMPLATE_VALUES)
        .optional()
        .describe(
          "Email template. 'claim_invite' = 'you're listed; claim your free profile'. Omit when sending free-form (subject + body)."
        ),
      subject: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Free-form subject. Provide with `body` instead of template_id to send any email."
        ),
      body: z
        .string()
        .min(1)
        .optional()
        .describe("Free-form plain-text body (a CAN-SPAM footer is appended automatically)."),
      html: z
        .string()
        .optional()
        .describe("Optional free-form HTML body. When omitted, HTML is derived from `body`."),
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

      // K41 — decide template vs free-form. subject+body wins; otherwise a
      // template_id is required.
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
      if (!freeForm && params.template_id === "claim_invite" && vendor.claimed) {
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

      // K36 — suppression gate. If the vendor unsubscribed, send NOTHING and
      // write no outreach/audit rows.
      if (await isEmailSuppressed(db, vendor.contactEmail)) {
        return {
          content: [
            jsonContent({
              success: false,
              suppressed: true,
              vendor_id: vendor.id,
              sent_to: vendor.contactEmail,
              note: "Recipient is on the suppression list (unsubscribed). Nothing was sent or logged.",
            }),
          ],
        };
      }

      const rendered = await applyCanSpamFooter(
        renderEmailBody({
          templateId: params.template_id,
          vendor: { businessName: vendor.businessName, slug: vendor.slug },
          subject: params.subject,
          body: params.body,
          html: params.html,
        }),
        {
          recipientEmail: vendor.contactEmail,
          reasonLine: "your business is listed on Meet Me at the Fair.",
          env,
        }
      );

      const mode = freeForm ? "free-form" : (params.template_id as string);

      // Primary send to the vendor.
      const primary: EmailJobMessage = {
        to: vendor.contactEmail,
        subject: rendered.subject.slice(0, 200),
        text: rendered.text,
        html: rendered.html,
        from: FROM,
        source: "email:vendor-outreach",
      };
      await env.EMAIL_JOBS.send(primary);

      // BCC copy to the operator (CF Email send() has no bcc field — second msg).
      const bccNote = `[BCC copy] The email below was sent to ${vendor.businessName} <${vendor.contactEmail}> via send_vendor_email (${mode}).\n\n----------\n\n`;
      const bcc: EmailJobMessage = {
        to: BCC_TO,
        subject: `[BCC] ${rendered.subject}`.slice(0, 200),
        text: bccNote + rendered.text,
        html: `<p>${escapeHtml(bccNote.trim())}</p>${rendered.html}`,
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
        notes: `send_vendor_email: ${mode}`.slice(0, 500),
        createdBy: auth.userId,
      });

      // Audit trail.
      await db.insert(adminActions).values({
        action: "vendor.email_sent",
        actorUserId: auth.userId,
        targetType: "vendor",
        targetId: vendor.id,
        payloadJson: JSON.stringify({
          template_id: params.template_id ?? null,
          mode,
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
            mode,
            template_id: params.template_id ?? null,
            sent_to: vendor.contactEmail,
            bcc: BCC_TO,
            outreach_attempt_id: attemptId,
          }),
        ],
      };
    }
  );

  // K36 — operator visibility into the suppression list (acceptance: "admin can
  // see the suppression list"). Read-only.
  server.tool(
    "list_email_suppressions",
    "List addresses on the email suppression list (people who unsubscribed or were manually suppressed). Solicited sends (send_vendor_email, send_test_email, K41 free-form) skip these. Admin only.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max rows to return (most recent first). Default 100."),
    },
    async (params) => {
      const rows = await db
        .select()
        .from(emailSuppressionList)
        .orderBy(desc(emailSuppressionList.createdAt))
        .limit(params.limit ?? 100);
      return {
        content: [
          jsonContent({
            count: rows.length,
            suppressions: rows.map((r) => ({
              email: r.email,
              reason: r.reason,
              source: r.source,
              created_at: r.createdAt,
            })),
          }),
        ],
      };
    }
  );
}
