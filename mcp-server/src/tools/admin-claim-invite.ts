/**
 * `create_claim_invite` admin MCP tool — OPE-67.
 *
 * The analyst-facing rail for the cold-contact invite campaign: mint a
 * single-use, 14-day INVITE_TOKEN for an UNCLAIMED vendor/promoter listing and
 * email its contact address a magic link that drops the recipient into the
 * OPE-59 register funnel pre-seeded with the invite. When they sign up with
 * that same address, the OPE-64 wizard calls `redeemClaimToken`
 * (src/lib/claims/redeem-claim-token.ts) to flip ownership + write the deferred
 * entity_claims row.
 *
 * COLD-INVITE model (do NOT fight the schema):
 *   - entity_claims.userId is NOT NULL, so no entity_claims row can be written
 *     at invite time (there is no account yet). The claim attempt is deferred to
 *     REDEMPTION.
 *   - claim_tokens.userId is NULLABLE + there's an `email` column (drizzle/0145).
 *     A cold invite token is {entityType, entityId, userId:null, email, ...}.
 *
 * Reuses admin-send-vendor-email's send rails EXACTLY: applyCanSpamFooter (unsub
 * + mailing-address footer), isEmailSuppressed (opt-out gate), the FROM sender,
 * the EMAIL_JOBS primary+BCC enqueue pattern, and — for vendors only — a
 * vendor_outreach_attempts row so the claim leaderboard reflects the touch.
 *
 * SECURITY / STOP-GATE: this tool CAN email real people. The raw token is
 * returned ONLY inside the email magic link — never in the tool result.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import {
  vendors,
  promoters,
  claimTokens,
  adminActions,
  vendorOutreachAttempts,
} from "../schema.js";
import { jsonContent } from "../helpers.js";
import {
  applyCanSpamFooter,
  isEmailSuppressed,
  FROM,
  type RenderedEmail,
  type SendVendorEmailEnv,
} from "./admin-send-vendor-email.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

const PUBLIC_HOST = "https://meetmeatthefair.com";
const BCC_TO = "jtarboxme@gmail.com";
const SIGN_OFF = "— Meet Me at the Fair";
// 14-day invite window (spec §4). Longer than the 24h self-serve claim token
// because a cold contact needs time to notice + act on an unsolicited invite.
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const TOKEN_BYTE_LENGTH = 32;

interface EmailJobMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
  source: string;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return toHex(hash);
}

/** 32 random bytes, hex-encoded. Raw token — only ever leaves this Worker in
 *  the email magic link. */
function generateRawToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return toHex(bytes.buffer);
}

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

/**
 * The magic link that carries the invite into the OPE-59 register funnel. The
 * `invite=<raw token>` param is what the OPE-64 wizard hands to
 * `redeemClaimToken`. `role` pre-selects the register role; `claim` pre-selects
 * the listing by slug.
 */
function inviteUrl(entityType: "VENDOR" | "PROMOTER", slug: string, rawToken: string): string {
  return `${PUBLIC_HOST}/register?role=${entityType}&claim=${encodeURIComponent(slug)}&invite=${rawToken}`;
}

/** claim_invite copy (mirrors admin-send-vendor-email's buildTemplate) with the
 *  invite magic link substituted for the plain claim URL. */
function renderInviteEmail(businessName: string, url: string): RenderedEmail {
  const text = `Hi ${businessName},

You're listed on Meet Me at the Fair — the New England directory connecting fair-, festival-, and craft-show-goers across all six states with the businesses they love. We built your listing from public event data, and we'd love for you to claim it (it's free).

Claiming lets you correct your details, add photos and products, and link your website so shoppers can find you. This link is just for you and gets you straight there:
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

export function registerCreateClaimInviteTool(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: SendVendorEmailEnv
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "create_claim_invite",
    "Cold-contact claim invite (OPE-67). Mint a single-use, 14-day INVITE_TOKEN for an UNCLAIMED vendor or promoter listing and email its contact address a magic link into the claim/register funnel. Idempotent: if an unexpired invite already exists for the same (entity, email) it is a no-op (created:false, reason:active_invite_exists). Honors the suppression list (suppressed:true, nothing sent/minted). Does NOT write an entity_claims row (deferred to redemption — entity_claims.user_id is NOT NULL). The raw token is emailed only, never returned. For vendors, records a vendor_outreach_attempts touch. Admin only.",
    {
      entity_type: z
        .enum(["VENDOR", "PROMOTER"])
        .describe("Which listing kind to invite the contact to claim."),
      entity_id: z.string().min(1).describe("ID of the vendor/promoter row. Must be unclaimed."),
      email: z
        .string()
        .email()
        .optional()
        .describe(
          "Override recipient. Defaults to the listing's contact_email. Compared lowercased."
        ),
    },
    async ({ entity_type, entity_id, email }) => {
      if (!env?.EMAIL_JOBS) {
        return {
          content: [
            {
              type: "text",
              text: "create_claim_invite requires the EMAIL_JOBS queue binding on the MCP Worker.",
            },
          ],
          isError: true,
        };
      }

      // 1. Load the entity; must exist and be UNCLAIMED. Vendors exclude
      //    soft-deleted rows (mirrors resolveClaimAtSignup).
      let entity:
        | { id: string; name: string; slug: string; contactEmail: string | null; claimed: boolean }
        | undefined;
      if (entity_type === "VENDOR") {
        const [row] = await db
          .select({
            id: vendors.id,
            name: vendors.businessName,
            slug: vendors.slug,
            contactEmail: vendors.contactEmail,
            claimed: vendors.claimed,
          })
          .from(vendors)
          .where(and(eq(vendors.id, entity_id), isNull(vendors.deletedAt)))
          .limit(1);
        entity = row ? { ...row, slug: row.slug as unknown as string } : undefined;
      } else {
        const [row] = await db
          .select({
            id: promoters.id,
            name: promoters.companyName,
            slug: promoters.slug,
            contactEmail: promoters.contactEmail,
            claimed: promoters.claimed,
          })
          .from(promoters)
          .where(eq(promoters.id, entity_id))
          .limit(1);
        entity = row ? { ...row, slug: row.slug as unknown as string } : undefined;
      }

      if (!entity) {
        return {
          content: [
            jsonContent({
              error: "entity_not_found",
              entityType: entity_type,
              entityId: entity_id,
            }),
          ],
          isError: true,
        };
      }
      if (entity.claimed) {
        return {
          content: [
            jsonContent({
              error: "already_claimed",
              entityType: entity_type,
              entityId: entity_id,
              message: "Listing is already claimed — a claim invite would be confusing.",
            }),
          ],
          isError: true,
        };
      }

      const targetEmail = (email ?? entity.contactEmail ?? "").trim().toLowerCase();
      if (!targetEmail) {
        return {
          content: [
            jsonContent({
              error: "no_email",
              entityType: entity_type,
              entityId: entity_id,
              message: "No email supplied and the listing has no contact_email on file.",
            }),
          ],
          isError: true,
        };
      }

      // 2. Suppression gate — send nothing, mint nothing.
      if (await isEmailSuppressed(db, targetEmail)) {
        return {
          content: [
            jsonContent({
              created: false,
              suppressed: true,
              entityType: entity_type,
              entityId: entity_id,
              email: targetEmail,
              note: "Recipient is on the suppression list (unsubscribed). Nothing was sent or minted.",
            }),
          ],
        };
      }

      const now = new Date();

      // 3. Idempotency: look up any existing tokens for this (entity, email).
      //    An unexpired one → NO-OP. Expired ones are swept before re-minting.
      const existing = await db
        .select({ id: claimTokens.id, expiresAt: claimTokens.expiresAt })
        .from(claimTokens)
        .where(
          and(
            eq(claimTokens.entityType, entity_type),
            eq(claimTokens.entityId, entity_id),
            eq(claimTokens.email, targetEmail)
          )
        );
      const active = existing.find((r) => r.expiresAt.getTime() > now.getTime());
      if (active) {
        return {
          content: [
            jsonContent({
              created: false,
              reason: "active_invite_exists",
              entityType: entity_type,
              entityId: entity_id,
              email: targetEmail,
              expiresAt: active.expiresAt,
            }),
          ],
        };
      }
      for (const stale of existing) {
        await db.delete(claimTokens).where(eq(claimTokens.id, stale.id));
      }

      // 4. Mint the cold-invite token: userId NULL, email set.
      const rawToken = generateRawToken();
      const tokenHash = await sha256Hex(rawToken);
      const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
      await db.insert(claimTokens).values({
        id: crypto.randomUUID(),
        entityType: entity_type,
        entityId: entity_id,
        userId: null,
        email: targetEmail,
        tokenHash,
        createdAt: now,
        expiresAt,
      });

      // 5. Send the invite email, mirroring send_vendor_email's rails.
      const reasonLine =
        entity_type === "VENDOR"
          ? "your business is listed on Meet Me at the Fair."
          : "your organization is listed on Meet Me at the Fair.";
      const rendered = await applyCanSpamFooter(
        renderInviteEmail(entity.name, inviteUrl(entity_type, entity.slug, rawToken)),
        { recipientEmail: targetEmail, reasonLine, env }
      );

      const primary: EmailJobMessage = {
        to: targetEmail,
        subject: rendered.subject.slice(0, 200),
        text: rendered.text,
        html: rendered.html,
        from: FROM,
        source: "email:claim-invite",
      };
      await env.EMAIL_JOBS.send(primary);

      // BCC copy to the operator (CF Email send() has no bcc field — second msg).
      const bccNote = `[BCC copy] Claim invite sent to ${entity.name} <${targetEmail}> via create_claim_invite (${entity_type}).\n\n----------\n\n`;
      const bcc: EmailJobMessage = {
        to: BCC_TO,
        subject: `[BCC] ${rendered.subject}`.slice(0, 200),
        text: bccNote + rendered.text,
        html: `<p>${escapeHtml(bccNote.trim())}</p>${rendered.html}`,
        from: FROM,
        source: "email:claim-invite-bcc",
      };
      await env.EMAIL_JOBS.send(bcc);

      // Vendors get an outreach attempt so the claim leaderboard reflects the
      // touch. Promoters have no outreach table — skip.
      let outreachAttemptId: string | null = null;
      if (entity_type === "VENDOR") {
        outreachAttemptId = crypto.randomUUID();
        await db.insert(vendorOutreachAttempts).values({
          id: outreachAttemptId,
          vendorId: entity_id,
          attemptStartedAt: now,
          channel: "email",
          outcome: "sent",
          outcomeAt: now,
          notes: "create_claim_invite",
          createdBy: auth.userId,
        });
      }

      await db.insert(adminActions).values({
        action:
          entity_type === "VENDOR" ? "vendor.claim_invite_sent" : "promoter.claim_invite_sent",
        actorUserId: auth.userId,
        targetType: entity_type.toLowerCase(),
        targetId: entity_id,
        payloadJson: JSON.stringify({
          via: "create_claim_invite",
          to: targetEmail,
          bcc: BCC_TO,
          expiresAt: expiresAt.toISOString(),
          outreachAttemptId,
        }),
        createdAt: now,
      });

      return {
        content: [
          jsonContent({
            created: true,
            entityType: entity_type,
            entityId: entity_id,
            email: targetEmail,
            expiresAt,
          }),
        ],
      };
    }
  );
}
