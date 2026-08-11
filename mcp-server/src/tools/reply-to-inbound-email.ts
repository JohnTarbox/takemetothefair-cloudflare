/**
 * OPE-163 — `reply_to_inbound_email` admin MCP tool: reply to a received email
 * from the server, addressed to the ORIGINAL sender (works for any address, not
 * vendor-scoped — the gap vs `send_vendor_email`). Sends from
 * `support@meetmeatthefair.com` via the transactional EMAIL_JOBS pipeline,
 * threads the reply to the inbound (In-Reply-To/References = inbound Message-ID),
 * links + ledgers it (the consumer writes email_send_ledger with the
 * inbound_email_id + body), and marks the inbound `status='replied'`,
 * `reply_kind='manual'`. Plain transactional reply — NO marketing/unsubscribe
 * footer — but still hard-blocked against the suppression list.
 *
 * Gated behind EMAIL_REPLY_ENABLED (must equal "true"). Shipped OFF (OPE-6
 * customer-facing send path): the tool refuses to send until an operator flips
 * the flag. The compose UI on /admin/inbound-emails (a follow-up) reuses the
 * same enqueue path.
 *
 * Core logic is the exported `handleReplyToInbound` so it's unit-testable
 * against a throwaway SQLite + a mock queue, independent of the MCP wrapper.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { inboundEmails, adminActions, pendingEmailReplies } from "../schema.js";
// OPE-368 — shared with the admin route so both refusal sites behave identically.
import { buildRefusedReply, refusedReplyMessage } from "@takemetothefair/utils";
import { logError } from "../logger.js";
import { jsonContent } from "../helpers.js";
import { isEmailSuppressed } from "./admin-send-vendor-email.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

/** The reply's From line. `support@` per John's choice (OPE-163). Recipients
 *  reply here; ensure Cloudflare Email Routing routes support@ back to inbound
 *  so their replies thread (see the ticket's routing caveat). */
const REPLY_FROM = "Meet Me at the Fair <support@meetmeatthefair.com>";
const REPLY_SOURCE = "reply:manual";

/** Minimal shape of the EMAIL_JOBS queue message (mirrors the consumer's
 *  EmailJobMessage; kept local since mcp-server has no shared export). */
interface EmailJobMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
  source: string;
  inboundEmailId?: string;
  inReplyTo?: string;
  references?: string;
}

export interface ReplyDeps {
  emailJobs: { send: (msg: EmailJobMessage) => Promise<void> } | undefined;
  /** EMAIL_REPLY_ENABLED === "true". When false, nothing is sent (OPE-6 gate). */
  replyEnabled: boolean;
  actorUserId: string;
}

export interface ReplyArgs {
  inboundEmailId: string;
  subject?: string;
  body: string;
  html?: string;
}

export type ReplyResult =
  | { ok: false; reason: "disabled" | "no_queue" | "not_found" | "suppressed"; message: string }
  | { ok: true; to: string; subject: string; inboundEmailId: string };

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Plain-text → minimal HTML (paragraphs + line breaks). Same escaping posture
 *  as the auto-reply builder — no framework, tight deliverability surface. */
function textToHtml(text: string): string {
  return `<p>${escapeHtml(text).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
}

/**
 * Reply to an inbound email. Enqueues the reply (the consumer sends + ledgers)
 * and marks the inbound replied. Returns a discriminated result; never throws
 * for the expected refuse-to-send states (disabled/suppressed/not_found).
 */
export async function handleReplyToInbound(
  db: Db,
  deps: ReplyDeps,
  args: ReplyArgs
): Promise<ReplyResult> {
  // OPE-6 gate — refuse to send unless explicitly enabled.
  //
  // OPE-368 (R4): refusing is correct; DISCARDING was not. This branch used to
  // return a message and drop the composed prose on the floor, writing nothing
  // anywhere — so "an agent tried to answer a waiting customer and was refused"
  // was invisible to every detector we run. It surfaced on 2026-08-10 only
  // because a human was in the loop at the time.
  //
  // The draft is now preserved and the refusal is countable. The gate still
  // refuses: whether it opens is John's call alone, and this ticket does not
  // touch the flag.
  if (!deps.replyEnabled) {
    // Resolve the recipient so the saved draft is actionable on its own. Best
    // effort — a draft we cannot address is still worth keeping over losing the
    // operator's answer entirely.
    let toAddress = "(unknown)";
    try {
      const [target] = await db
        .select({ fromAddress: inboundEmails.fromAddress })
        .from(inboundEmails)
        .where(eq(inboundEmails.id, args.inboundEmailId))
        .limit(1);
      if (target?.fromAddress) toAddress = target.fromAddress;
    } catch {
      /* keep the placeholder — never lose the draft over a lookup */
    }

    const draftId = crypto.randomUUID();
    const record = buildRefusedReply(
      {
        inboundEmailId: args.inboundEmailId,
        toAddress,
        subject: args.subject ?? null,
        bodyText: args.body,
        requestedBy: deps.actorUserId,
      },
      new Date(),
      draftId
    );

    try {
      await db.insert(pendingEmailReplies).values(record);
    } catch (error) {
      // If even the draft cannot be saved, say so loudly rather than implying
      // it was kept — a false promise of preservation is worse than none.
      await logError(db, {
        level: "error",
        source: "email:reply-gate",
        message: "[OPE-368] refused reply — FAILED to persist draft",
        error,
        context: { inboundEmailId: args.inboundEmailId, actor: deps.actorUserId },
      });
      return {
        ok: false,
        reason: "disabled",
        message:
          "Reply sending is disabled AND the draft could not be saved. Copy your text before " +
          "retrying — it has not been preserved.",
      };
    }

    // The fault record. error_logs, not the discrepancy queue: error_logs is
    // what the existing dashboards and the email-stub sweep already read, and
    // a refusal is an operational fault rather than a data disagreement.
    await logError(db, {
      level: "warn",
      source: "email:reply-gate",
      message: `[OPE-368] reply refused (EMAIL_REPLY_ENABLED != true) — draft ${draftId} saved for review`,
      context: {
        inboundEmailId: args.inboundEmailId,
        draftId,
        actor: deps.actorUserId,
        toAddress,
      },
    });

    return {
      ok: false,
      reason: "disabled",
      message: refusedReplyMessage(draftId),
    };
  }
  if (!deps.emailJobs) {
    return {
      ok: false,
      reason: "no_queue",
      message: "reply_to_inbound_email requires the EMAIL_JOBS queue binding on the MCP Worker.",
    };
  }

  const [row] = await db
    .select({
      id: inboundEmails.id,
      fromAddress: inboundEmails.fromAddress,
      subject: inboundEmails.subject,
      messageId: inboundEmails.messageId,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, args.inboundEmailId))
    .limit(1);

  if (!row) {
    return {
      ok: false,
      reason: "not_found",
      message: `Inbound email not found: ${args.inboundEmailId}`,
    };
  }

  // Suppression safety net — never email an address that opted out, even a
  // solicited 1:1 reply.
  if (await isEmailSuppressed(db, row.fromAddress)) {
    return {
      ok: false,
      reason: "suppressed",
      message: `${row.fromAddress} is on the suppression list (unsubscribed). Nothing was sent.`,
    };
  }

  const subject = (args.subject?.trim() || `Re: ${row.subject || "your message"}`).slice(0, 200);
  const text = args.body;
  const html = args.html?.trim() ? args.html : textToHtml(args.body);

  const job: EmailJobMessage = {
    to: row.fromAddress,
    subject,
    text,
    html,
    from: REPLY_FROM,
    source: REPLY_SOURCE,
    inboundEmailId: row.id,
    ...(row.messageId ? { inReplyTo: row.messageId, references: row.messageId } : {}),
  };
  await deps.emailJobs.send(job);

  // Mark the inbound replied (optimistic — the ledger row the consumer writes is
  // the source of truth for actual delivery/failure).
  await db
    .update(inboundEmails)
    .set({ status: "replied", replyKind: "manual" })
    .where(eq(inboundEmails.id, row.id));

  await db.insert(adminActions).values({
    action: "inbound.reply_sent",
    actorUserId: deps.actorUserId,
    targetType: "inbound_email",
    targetId: row.id,
    payloadJson: JSON.stringify({ to: row.fromAddress, subject, via: "mcp" }),
    createdAt: new Date(),
  });

  return { ok: true, to: row.fromAddress, subject, inboundEmailId: row.id };
}

interface ReplyToolEnv {
  EMAIL_JOBS?: { send: (msg: EmailJobMessage) => Promise<void> };
  /** OPE-6 gate. Must equal "true" to actually send. Shipped OFF. */
  EMAIL_REPLY_ENABLED?: string;
}

export function registerReplyToInboundEmailTool(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: ReplyToolEnv
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "reply_to_inbound_email",
    "Reply to a received email (from /admin/inbound-emails) addressed to the ORIGINAL sender — works for ANY address, not just vendors. Sends from support@meetmeatthefair.com via the transactional pipeline, threads to the inbound (In-Reply-To/References), logs to email_send_ledger with the inbound_email_id + body, and marks the inbound status='replied'. Plain transactional reply (no marketing footer); honors the suppression list. Gated behind EMAIL_REPLY_ENABLED — returns disabled:true and sends nothing until an operator enables it. Admin only.",
    {
      inbound_email_id: z
        .string()
        .min(1)
        .describe("inbound_emails.id to reply to. Find via /admin/inbound-emails or list tools."),
      subject: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Reply subject. Defaults to 'Re: <original subject>'."),
      body: z.string().min(1).describe("Plain-text reply body (sent as-is; no footer appended)."),
      html: z
        .string()
        .optional()
        .describe("Optional HTML body. When omitted, HTML is derived from `body`."),
    },
    async (params) => {
      const result = await handleReplyToInbound(
        db,
        {
          emailJobs: env?.EMAIL_JOBS,
          replyEnabled: env?.EMAIL_REPLY_ENABLED === "true",
          actorUserId: auth.userId,
        },
        {
          inboundEmailId: params.inbound_email_id,
          subject: params.subject,
          body: params.body,
          html: params.html,
        }
      );

      if (result.ok) {
        return {
          content: [
            jsonContent({
              success: true,
              queued: true,
              inbound_email_id: result.inboundEmailId,
              to: result.to,
              subject: result.subject,
              from: REPLY_FROM,
              note: "Reply queued via the transactional pipeline; check the sent ledger for delivery.",
            }),
          ],
        };
      }

      // no_queue / not_found are real errors; disabled / suppressed are expected
      // refuse-to-send states surfaced as success:false (not isError).
      const isError = result.reason === "no_queue" || result.reason === "not_found";
      return {
        content: [jsonContent({ success: false, reason: result.reason, message: result.message })],
        isError,
      };
    }
  );
}
