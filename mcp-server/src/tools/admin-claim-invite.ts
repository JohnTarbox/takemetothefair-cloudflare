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
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  vendors,
  performers,
  promoters,
  claimTokens,
  adminActions,
  vendorOutreachAttempts,
  events,
} from "../schema.js";
import { decodeHtmlEntities, jsonContent, PUBLIC_EVENT_STATUSES } from "../helpers.js";
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
// 14-day invite window (spec §4). Longer than the 24h self-serve claim token
// because a cold contact needs time to notice + act on an unsolicited invite.
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const TOKEN_BYTE_LENGTH = 32;

/** OPE-1507 — stands in for the raw token in a dry-run preview. Not a token:
 *  no `claim_tokens` row hashes to it. */
export const DRY_RUN_TOKEN_PLACEHOLDER = "PREVIEW-ONLY-NO-TOKEN-MINTED";

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
function inviteUrl(
  entityType: "VENDOR" | "PROMOTER" | "PERFORMER",
  slug: string,
  rawToken: string
): string {
  // OPE-318 — performers land on their own claim page, NOT the register funnel's
  // `role=` path. `role=PERFORMER` would be a role that does not exist
  // (userRoles has no such value), so the link would carry an instruction the
  // register route cannot honour.
  if (entityType === "PERFORMER") {
    return `${PUBLIC_HOST}/claim/performer/${encodeURIComponent(slug)}?invite=${rawToken}`;
  }
  return `${PUBLIC_HOST}/register?role=${entityType}&claim=${encodeURIComponent(slug)}&invite=${rawToken}`;
}

/**
 * OPE-1340 — the magic link as a real `<a href>`, styled like the main app's
 * email CTA (src/lib/email/templates.ts, "Read the post"). The MCP Worker cannot
 * import that module, so the one line of markup is mirrored here.
 *
 * Before this, the URL went through `paragraphsToHtml` with the rest of the body
 * and reached the HTML part as bare text — clickable only if the recipient's
 * mail client happened to auto-link a ~200-character URL (AOL webmail does not
 * reliably). The bare URL stays in the text part, and as a plain visible link
 * under the button for clients that strip button styling.
 */
function ctaButtonHtml(url: string, label: string): string {
  const href = escapeHtml(url);
  return (
    `<div style="margin:16px 0;"><a href="${href}" style="display:inline-block;padding:12px 20px;` +
    `background:#E8960C;color:#1E2761;font-weight:600;text-decoration:none;border-radius:8px;">` +
    `${escapeHtml(label)}</a></div>` +
    `<p style="font-size:13px;color:#6F6455;">Or open this link: <a href="${href}">${href}</a></p>`
  );
}

export type ClaimInviteEntityType = "VENDOR" | "PROMOTER" | "PERFORMER";

/** OPE-1340 — John's standard sign-off (ruling 2026-10-20, Option A): "John",
 *  then the site as a link. No last name. Every invite carries exactly one. */
const SIGN_OFF_TEXT = `John\n${PUBLIC_HOST}`;
const SIGN_OFF_HTML = `<p>John<br><a href="${PUBLIC_HOST}">meetmeatthefair.com</a></p>`;

/** OPE-1340 — the 14-day / single-use line, shared by the PROMOTER and PERFORMER
 *  copy and the OPE-1507 personal-note path. */
export const FOURTEEN_DAY_LINE =
  "This link is just for you and works for 14 days. If you have questions, reply to this email.";

/**
 * OPE-1340 — the "tell us about your other shows" paragraph, approved by John
 * 2026-10-20 10:17 ET, one line per entity type. Rendered after the button and
 * before the 14-day line, on the default AND the personal-note path, from this
 * one constant so the two cannot drift.
 *
 * ⚠️ NOT LIVE (`OTHER_SHOWS_LIVE = false`). The same ruling made it conditional
 * on a reply to an `email:claim-invite` send reaching a human as an answer to our
 * message. Read 2026-10-20, it does not: `decideOwedHuman` (email-handlers/
 * owed-human.ts) owes a human only when the thread's previous send was
 * `reply:manual*`, and its previous-send lookup joins the ledger through
 * `inbound_email_id`, which a cold invite does not have — so a vendor answering
 * "I'll be at these shows" would be classified like any fresh inbound (possibly
 * a new submission, with an auto-ack). Reported on OPE-1340; flip this only
 * once that routing exists.
 */
export const OTHER_SHOWS_PARAGRAPH: Record<ClaimInviteEntityType, string> = {
  VENDOR:
    "Will you be at other shows this season? Reply with the show names and dates and we'll add them to your page. After you claim it, you can also pick shows we already list from your profile.",
  PROMOTER:
    "Running other shows we don't list yet? Reply with the names and dates and we'll add them.",
  PERFORMER:
    "Playing at other fairs or festivals? Reply with where and when and we'll add them to your page.",
};
export const OTHER_SHOWS_LIVE = false;

/** OPE-1507 — a personal note may be at most this long. */
export const PERSONAL_NOTE_MAX = 2000;

export interface InviteRenderInput {
  entityType: ClaimInviteEntityType;
  /** Business / organization / act name. */
  name: string;
  url: string;
  /** PROMOTER only: public, upcoming shows on the page. 0 drops the sentence. */
  upcomingShows?: number;
  /** OPE-1507 — replaces the greeting and body paragraphs when present. */
  personalNote?: string | null;
  /** OPE-1507 — overrides the template subject when present. */
  subject?: string | null;
  /** Defaults to OTHER_SHOWS_LIVE. Explicit only in tests. */
  otherShows?: boolean;
}

/** OPE-1507 — escape, keep paragraph breaks, and make bare https:// URLs real
 *  links (the OPE-1340 lesson: a URL a client must auto-link is not a link). */
function noteToHtml(note: string): string {
  return note
    .trim()
    .split(/\n{2,}/)
    .map((para) => {
      const html = escapeHtml(para)
        .replace(/https:\/\/[^\s<]+/g, (m) => {
          const trail = /[.,;:!?)]+$/.exec(m)?.[0] ?? "";
          const href = trail ? m.slice(0, -trail.length) : m;
          return `<a href="${href}">${href}</a>${trail}`;
        })
        .replace(/\n/g, "<br>");
      return `<p>${html}</p>`;
    })
    .join("");
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The body paragraphs ABOVE the button, per entity type (default path). */
function defaultIntro(input: InviteRenderInput): { subject: string; text: string; html: string } {
  if (input.entityType === "PROMOTER") {
    // OPE-1340 Option A, verbatim from the 10-11 AGENT BLOCKED draft.
    const lead = `Hello,

${input.name} is listed on Meet Me at the Fair, a free directory that helps people across New England find fairs, festivals and craft shows. We built your page from public information, and we'd like you to take it over. It's free.`;
    const n = input.upcomingShows ?? 0;
    const shows = n > 0 ? `Your page shows ${plural(n, "upcoming show", "upcoming shows")}. ` : "";
    const can = `${shows}Once it's yours, you can:`;
    const bullets = [
      "see all your shows on the site in one place",
      "add a new show, or copy this year's to next year in a couple of clicks",
      "send us corrections to dates, hours or vendor details, and we'll update them",
    ];
    return {
      subject: "Your shows are on Meet Me at the Fair — claim your page",
      text: `${lead}\n\n${can}\n${bullets.map((b) => `- ${b}`).join("\n")}`,
      html: `${paragraphsToHtml(lead)}<p>${escapeHtml(can)}</p><ul>${bullets
        .map((b) => `<li>${escapeHtml(b)}</li>`)
        .join("")}</ul>`,
    };
  }
  if (input.entityType === "PERFORMER") {
    const lead = `Hello,

${input.name} has a page on Meet Me at the Fair, a free directory of New England fairs, festivals and craft shows. It lists where you're performing, drawn from public event listings. Claiming it marks the page as yours, and you can reply any time with new dates or corrections. It's free.`;
    return {
      subject: "Claim your performer page on Meet Me at the Fair",
      text: lead,
      html: paragraphsToHtml(lead),
    };
  }
  // VENDOR — copy unchanged by OPE-1340 (ruling: "VENDOR copy is unchanged").
  const intro = `Hi ${input.name},

You're listed on Meet Me at the Fair — the New England directory connecting fair-, festival-, and craft-show-goers across all six states with the businesses they love. We built your listing from public event data, and we'd love for you to claim it (it's free).

Claiming lets you correct your details, add photos and products, and link your website so shoppers can find you. This link is just for you and gets you straight there:`;
  return {
    subject: "Claim your free listing on Meet Me at the Fair",
    text: intro,
    html: paragraphsToHtml(intro),
  };
}

/**
 * Renders the claim invite. Exported for tests.
 *
 * Order (OPE-1340 + OPE-1507): body → Claim button → [other-shows paragraph] →
 * closing line(s) → ONE sign-off. The CAN-SPAM footer is applied by the caller.
 *
 * - Default path: the entity type's approved copy. VENDOR keeps its own closing
 *   paragraphs (its copy is unchanged); PROMOTER and PERFORMER close with the
 *   14-day line. The vendor's old "— Meet Me at the Fair" sign-off is replaced
 *   by John's, so no email carries two.
 * - Personal-note path (OPE-1507): the note REPLACES the greeting and body; then
 *   the button, the 14-day line and the sign-off. No template greeting is added.
 */
export function renderInviteEmail(input: InviteRenderInput): RenderedEmail {
  const otherShows =
    (input.otherShows ?? OTHER_SHOWS_LIVE) ? OTHER_SHOWS_PARAGRAPH[input.entityType] : null;
  const note = input.personalNote?.trim() ? input.personalNote.trim() : null;
  const intro = defaultIntro(input);
  const subject = input.subject?.trim() ? input.subject.trim() : intro.subject;

  const closing =
    !note && input.entityType === "VENDOR"
      ? `There's no cost and no catch — claiming just puts you in control of how your business appears.

If you have any questions, just reply to this email.`
      : FOURTEEN_DAY_LINE;

  const textParts = [
    note ?? intro.text,
    // The bare claim URL stays in the text part (OPE-1340), indented as before.
    `  ${input.url}`,
    ...(otherShows ? [otherShows] : []),
    closing,
    SIGN_OFF_TEXT,
  ];
  // The default vendor text keeps its original shape: intro, newline, URL.
  const text =
    !note && input.entityType === "VENDOR"
      ? `${textParts[0]}\n${textParts.slice(1).join("\n\n")}`
      : textParts.join("\n\n");

  const html =
    (note ? noteToHtml(note) : intro.html) +
    ctaButtonHtml(input.url, "Claim your page") +
    (otherShows ? paragraphsToHtml(otherShows) : "") +
    paragraphsToHtml(closing) +
    SIGN_OFF_HTML;

  return { subject, text, html };
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
    "Cold-contact claim invite (OPE-67; OPE-318 added PERFORMER). Mint a single-use, 14-day INVITE_TOKEN for an UNCLAIMED vendor, promoter or performer listing and email its contact address a magic link into the claim/register funnel. Idempotent: if an unexpired invite already exists for the same (entity, email) it is a no-op (created:false, reason:active_invite_exists) unless `resend: true`, which revokes it and sends a fresh link (OPE-1340). Honors the suppression list (suppressed:true, nothing sent/minted). Does NOT write an entity_claims row (deferred to redemption — entity_claims.user_id is NOT NULL). The raw token is emailed only, never returned. For vendors, records a vendor_outreach_attempts touch. Admin only.",
    {
      entity_type: z
        .enum(["VENDOR", "PROMOTER", "PERFORMER"])
        .describe("Which listing kind to invite the contact to claim."),
      entity_id: z
        .string()
        .min(1)
        .describe("ID of the vendor/promoter/performer row. Must be unclaimed."),
      email: z
        .string()
        .email()
        .optional()
        .describe(
          "Override recipient. Defaults to the listing's contact_email. Compared lowercased."
        ),
      resend: z
        .boolean()
        .optional()
        .describe(
          "OPE-1340 — reissue: when an unexpired invite already exists for this (entity, email), revoke it and mint + send a fresh one instead of returning active_invite_exists. The earlier link stops working. Use when an invite was lost or its link broke."
        ),
      personal_note: z
        .string()
        .max(PERSONAL_NOTE_MAX)
        // Decoded at the boundary (CLAUDE.md): the renderer escapes once, so an
        // agent's `&amp;` must arrive as `&`, not reach the reader as "&amp;".
        .transform(decodeHtmlEntities)
        .optional()
        .describe(
          `OPE-1507 — plain text (max ${PERSONAL_NOTE_MAX} chars). REPLACES the template's greeting and body paragraphs, so the operator's message and the claim button go out as ONE email: note → "Claim your page" button → 14-day line → sign-off ("John" / meetmeatthefair.com) → unsubscribe footer. Paragraph breaks are kept, HTML is escaped, bare https:// URLs become links. Do not sign it — the sign-off is added once.`
        ),
      subject: z
        .string()
        .max(200)
        .transform(decodeHtmlEntities)
        .optional()
        .describe("OPE-1507 — overrides the template subject line."),
      dry_run: z
        .boolean()
        .optional()
        .describe(
          "OPE-1507 — render exactly what would be sent (recipient, subject, body_html, body_text) with a placeholder in place of the token, and STOP: mints nothing, sends nothing, writes no ledger, outreach or audit row. Use it to show the operator the email before a live send."
        ),
    },
    async ({ entity_type, entity_id, email, resend, personal_note, subject, dry_run }) => {
      if (!dry_run && !env?.EMAIL_JOBS) {
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
      } else if (entity_type === "PERFORMER") {
        // OPE-318 — explicit branch. The old two-value `else` meant "promoter",
        // so a performer id would have been looked up in the promoters table and
        // reported as not found — or worse, matched a promoter sharing the id
        // space and invited a stranger to claim the wrong listing.
        const [row] = await db
          .select({
            id: performers.id,
            name: performers.name,
            slug: performers.slug,
            contactEmail: performers.contactEmail,
            claimed: performers.claimed,
          })
          .from(performers)
          .where(and(eq(performers.id, entity_id), isNull(performers.deletedAt)))
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

      // OPE-1340 — {N} in the promoter copy: public, upcoming shows on the page.
      let upcomingShows = 0;
      if (entity_type === "PROMOTER") {
        const [c] = await db
          .select({ n: sql<number>`count(*)` })
          .from(events)
          .where(
            and(
              eq(events.promoterId, entity_id),
              isNull(events.mergedInto),
              inArray(events.status, [...PUBLIC_EVENT_STATUSES]),
              sql`coalesce(${events.endDate}, ${events.startDate}) >= ${Math.floor(now.getTime() / 1000)}`
            )
          );
        upcomingShows = Number(c?.n ?? 0);
      }
      const renderInput = {
        entityType: entity_type,
        name: entity.name,
        upcomingShows,
        personalNote: personal_note ?? null,
        subject: subject ?? null,
      };
      const reasonLine =
        entity_type === "VENDOR"
          ? "your business is listed on Meet Me at the Fair."
          : "your organization is listed on Meet Me at the Fair.";

      // OPE-1507 — dry run: the email exactly as it would go, token replaced by
      // a placeholder, and nothing written anywhere. Runs AFTER every gate above
      // (missing, claimed, no email, suppressed) so a preview never shows an
      // email the live call would refuse to send.
      if (dry_run) {
        const preview = await applyCanSpamFooter(
          renderInviteEmail({
            ...renderInput,
            url: inviteUrl(entity_type, entity.slug, DRY_RUN_TOKEN_PLACEHOLDER),
          }),
          { recipientEmail: targetEmail, reasonLine, env }
        );
        const wouldNoop = Boolean(active && !resend);
        return {
          content: [
            jsonContent({
              dry_run: true,
              would_send: !wouldNoop,
              ...(wouldNoop
                ? {
                    reason: "active_invite_exists",
                    note: "A live send would be a no-op: an unexpired invite exists. Pass resend: true to replace it.",
                  }
                : {}),
              entityType: entity_type,
              entityId: entity_id,
              to: targetEmail,
              bcc: BCC_TO,
              personalNote: Boolean(personal_note?.trim()),
              subject: preview.subject.slice(0, 200),
              body_html: preview.html,
              body_text: preview.text,
            }),
          ],
        };
      }
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
      // OPE-1340 — `resend` revokes the live token (swept with the stale ones
      // below) so a broken or lost invite can be replaced inside its 14 days.
      // Only ever one live token per (entity, email): the old link dies here.
      const reissued = Boolean(active && resend);
      if (active && !resend) {
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
      const rendered = await applyCanSpamFooter(
        renderInviteEmail({ ...renderInput, url: inviteUrl(entity_type, entity.slug, rawToken) }),
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
          // OPE-1507 — say whether the operator's own words went out.
          notes: personal_note?.trim()
            ? "create_claim_invite (personal note)"
            : "create_claim_invite",
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
          reissued,
          // OPE-1507 — the ledger row carries the rendered body itself (note
          // included); these flags make the choice filterable here.
          personalNote: Boolean(personal_note?.trim()),
          subjectOverride: Boolean(subject?.trim()),
        }),
        createdAt: now,
      });

      return {
        content: [
          jsonContent({
            created: true,
            reissued,
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
