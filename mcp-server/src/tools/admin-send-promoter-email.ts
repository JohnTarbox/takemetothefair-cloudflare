/**
 * OPE-384 stage 1 — `send_promoter_email`, the missing capability.
 *
 * On 2026-08-13 an event needed its dates confirmed by the only party who
 * actually knows them — the organizer — and there was no way to ask. A human
 * hand-sent it from `hello@`. When the reply arrives, nothing links it back to
 * "this was our date-confirmation ask for event X."
 *
 * ── Why none of the three existing senders fit ───────────────────────────
 *
 *   reply_to_inbound_email  needs an `inbound_email_id`. A promoter we want to
 *                           INITIATE contact with has not emailed us.
 *   send_vendor_email       needs a `vendor_id` and appends a CAN-SPAM
 *                           marketing footer. A promoter is not a vendor, and
 *                           minting a fake vendor row to reach one would both
 *                           pollute the vendor table and frame a peer B2B
 *                           question as marketing.
 *   send_test_email         force-prefixes `[TEST]`.
 *
 * ── Transactional, not marketing — and what that does NOT excuse ─────────
 *
 * No unsubscribe footer: this is a one-to-one question about a listing the
 * organizer already has, which is the same category as a reply to their own
 * email, not a campaign.
 *
 * It still honours the suppression list. Someone who has told us to stop
 * emailing them has said so about US, not about a category we chose for our own
 * convenience — and "transactional" is exactly the label every sender reaches
 * for when it wants to keep mailing an opt-out.
 *
 * ── The gate, and why refusal writes a row ───────────────────────────────
 *
 * Sends require `PROMOTER_OUTREACH_ENABLED === "true"`, which ships FALSE. Copy
 * reaching a real organizer needs John's approval first.
 *
 * A refused send still writes its attempt row, with `status='queued'`. That is
 * OPE-368's lesson applied before it can be relearned: the gate there discarded
 * composed prose at the moment of refusal, so the answer somebody had written
 * for a waiting customer simply evaporated. Here the ask survives the refusal
 * and becomes drainable the day the flag flips.
 *
 * This tool never lifts its own gate. `list_promoter_outreach` shows what is
 * queued; flipping the flag is John's.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  adminActions,
  events,
  promoters,
  promoterOutreachAttempts,
  OPEN_PROMOTER_OUTREACH_STATUSES,
} from "../schema.js";
import { jsonContent, decodeHtmlEntities } from "../helpers.js";
import { isEmailSuppressed } from "./admin-send-vendor-email.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

/** Replies must land back in the inbound queue, so we write from a monitored box. */
const FROM = "hello@meetmeatthefair.com";

/** Plain transactional sign-off. Deliberately not the marketing footer. */
const SIGN_OFF = "— The Meet Me at the Fair team\nhttps://meetmeatthefair.com";

export interface SendPromoterEmailEnv {
  EMAIL_JOBS?: { send: (msg: unknown) => Promise<unknown> };
  PROMOTER_OUTREACH_ENABLED?: string;
}

/** Minimal HTML rendering, matching the vendor path's paragraph treatment. */
function paragraphsToHtml(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<p>${esc.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
}

/**
 * Is there already an open ask for this event?
 *
 * The database enforces this too (partial unique index), and both exist on
 * purpose: the index makes a double-ask impossible, this makes the refusal
 * *legible* — a caller gets "we already asked, here is the attempt id" rather
 * than a constraint violation it has to decode.
 */
export async function findOpenAttemptForEvent(
  db: Db,
  eventId: string
): Promise<{ id: string; status: string; createdAt: Date | null } | null> {
  const [row] = await db
    .select({
      id: promoterOutreachAttempts.id,
      status: promoterOutreachAttempts.status,
      createdAt: promoterOutreachAttempts.createdAt,
    })
    .from(promoterOutreachAttempts)
    .where(
      and(
        eq(promoterOutreachAttempts.eventId, eventId),
        inArray(promoterOutreachAttempts.status, [...OPEN_PROMOTER_OUTREACH_STATUSES])
      )
    )
    .limit(1);
  return row ?? null;
}

/**
 * The seed confirmation ask, from the Dartmouth walkthrough.
 *
 * Deliberately asks rather than asserts. We hold dates we cannot corroborate;
 * telling an organizer "your fair is on Sep 11–12" when their own site says
 * otherwise invites them to correct our confidence rather than supply the fact.
 */
export function buildConfirmationAsk(args: {
  eventName: string;
  eventUrl?: string | null;
  currentDates?: string | null;
}): { subject: string; body: string } {
  const listed = args.currentDates
    ? `We currently show ${args.currentDates}, but we haven't been able to confirm that against your own listing, so we'd rather ask than guess.`
    : `We don't have confirmed dates for it yet, and we'd rather ask than guess.`;
  const link = args.eventUrl ? `\n\nOur listing: ${args.eventUrl}` : "";
  return {
    subject: `Confirming this year's dates for ${args.eventName}`,
    body: `Hello,

We list ${args.eventName} on Meet Me at the Fair, a free directory of fairs and craft shows in New England.

${listed}

If you have a moment, could you confirm:

  • This year's dates
  • Opening and closing times each day
  • Whether you're accepting vendor or crafter applications, and where to apply

Just reply to this email — whatever you can tell us, we'll put straight onto the listing. There's no cost and nothing to sign up for.${link}

Thank you,
${SIGN_OFF}`,
  };
}

export function registerSendPromoterEmailTool(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: SendPromoterEmailEnv
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "send_promoter_email",
    [
      "OPE-384 — ask an event's ORGANIZER to confirm details we can't corroborate",
      "(dates, hours, vendor applications). Free-form transactional B2B mail from a",
      "monitored address, so replies land back in the inbound queue.",
      "",
      "Distinct from send_vendor_email: no vendor_id, and NO marketing/unsubscribe",
      "footer. Still honours the suppression list.",
      "",
      "Gated by PROMOTER_OUTREACH_ENABLED, which ships false — a refused send is",
      "still RECORDED as a queued attempt so the prose survives and can be drained",
      "when the flag flips. Refuses a second open ask for the same event. Admin only.",
    ].join(" "),
    {
      event_id: z
        .string()
        .optional()
        .describe("Event this ask is about. Its promoter is used unless promoter_id is given."),
      promoter_id: z
        .string()
        .optional()
        .describe("Promoter to write to. Required when event_id is omitted."),
      subject: z.string().min(1).max(200).transform(decodeHtmlEntities).optional(),
      body: z
        .string()
        .min(1)
        .max(20000)
        .transform(decodeHtmlEntities)
        .optional()
        .describe("Plain-text body. Omit with an event_id to use the confirmation template."),
      html: z.string().optional(),
      reason: z
        .string()
        .max(500)
        .optional()
        .describe("Why this event needs confirmation — carried onto the attempt row."),
    },
    async (params) => {
      if (!params.event_id && !params.promoter_id) {
        return {
          content: [{ type: "text", text: "Provide event_id or promoter_id." }],
          isError: true,
        };
      }

      // ── Resolve the event (if any) and the promoter ───────────────────
      let event: { id: string; name: string; slug: string; promoterId: string } | undefined;
      if (params.event_id) {
        [event] = await db
          .select({
            id: events.id,
            name: events.name,
            slug: events.slug,
            promoterId: events.promoterId,
          })
          .from(events)
          .where(eq(events.id, params.event_id))
          .limit(1);
        if (!event) {
          return {
            content: [{ type: "text", text: `Event not found: ${params.event_id}` }],
            isError: true,
          };
        }
      }

      const promoterId = params.promoter_id ?? event?.promoterId;
      if (!promoterId) {
        return {
          content: [{ type: "text", text: "Could not resolve a promoter to write to." }],
          isError: true,
        };
      }

      const [promoter] = await db
        .select({
          id: promoters.id,
          companyName: promoters.companyName,
          contactEmail: promoters.contactEmail,
        })
        .from(promoters)
        .where(eq(promoters.id, promoterId))
        .limit(1);
      if (!promoter) {
        return {
          content: [{ type: "text", text: `Promoter not found: ${promoterId}` }],
          isError: true,
        };
      }

      // Fail LOUDLY on a missing contact, per the ticket. The common case is
      // the `system-community-suggestions` placeholder holding an
      // auto-ingested event — there is no organizer behind it to write to, and
      // silently doing nothing would make the outreach queue look drained when
      // it is merely stuck.
      if (!promoter.contactEmail) {
        return {
          content: [
            jsonContent({
              success: false,
              blocked: "no_contact_email",
              promoter_id: promoter.id,
              promoter: promoter.companyName,
              note:
                "This promoter has no contact_email, so there is nobody to ask. " +
                "Enrich the promoter first (promoter-enrichment rails, OPE-35/39), " +
                "or attach the organizer's address, then retry.",
            }),
          ],
          isError: true,
        };
      }

      if (await isEmailSuppressed(db, promoter.contactEmail)) {
        return {
          content: [
            jsonContent({
              success: false,
              blocked: "suppressed",
              promoter_id: promoter.id,
              note: "Recipient is on the suppression list. Nothing sent, nothing logged.",
            }),
          ],
        };
      }

      // ── Never double-ask ──────────────────────────────────────────────
      if (event) {
        const open = await findOpenAttemptForEvent(db, event.id);
        if (open) {
          return {
            content: [
              jsonContent({
                success: false,
                blocked: "already_open",
                attempt_id: open.id,
                status: open.status,
                note:
                  "There is already an open ask for this event. Wait for a reply or the " +
                  "no-response timeout before following up — asking twice reads as a bot.",
              }),
            ],
          };
        }
      }

      // ── Compose ───────────────────────────────────────────────────────
      const composed =
        params.subject && params.body
          ? { subject: params.subject, body: params.body }
          : event
            ? buildConfirmationAsk({
                eventName: event.name,
                eventUrl: `https://meetmeatthefair.com/events/${event.slug}`,
              })
            : null;
      if (!composed) {
        return {
          content: [
            {
              type: "text",
              text: "Provide subject + body, or an event_id to use the confirmation template.",
            },
          ],
          isError: true,
        };
      }

      const now = new Date();
      const attemptId = crypto.randomUUID();
      const enabled = env?.PROMOTER_OUTREACH_ENABLED === "true";

      // The row is written BEFORE the send, always — including when the gate
      // refuses. See the module docblock: a refused send that leaves no trace
      // is the defect OPE-368 was filed for.
      await db.insert(promoterOutreachAttempts).values({
        id: attemptId,
        promoterId: promoter.id,
        eventId: event?.id ?? null,
        channel: "email",
        toAddress: promoter.contactEmail,
        subject: composed.subject.slice(0, 200),
        bodyText: composed.body,
        reason: params.reason ?? null,
        status: "queued",
        requestedBy: auth.userId ?? null,
        createdAt: now,
      });

      if (!enabled || !env?.EMAIL_JOBS) {
        return {
          content: [
            jsonContent({
              success: false,
              queued: true,
              attempt_id: attemptId,
              promoter_id: promoter.id,
              event_id: event?.id ?? null,
              would_send_to: promoter.contactEmail,
              subject: composed.subject,
              note: !enabled
                ? "PROMOTER_OUTREACH_ENABLED is not 'true' — nothing was sent. The ask is " +
                  "SAVED as a queued attempt, not discarded; review it with " +
                  "list_promoter_outreach. Organizer-facing copy needs John's approval " +
                  "before the flag is flipped."
                : "EMAIL_JOBS binding not configured — the ask is saved as queued.",
            }),
          ],
        };
      }

      await env.EMAIL_JOBS.send({
        to: promoter.contactEmail,
        subject: composed.subject.slice(0, 200),
        text: composed.body,
        html: params.html ?? paragraphsToHtml(composed.body),
        from: FROM,
        source: "email:promoter-outreach",
      });

      await db
        .update(promoterOutreachAttempts)
        .set({ status: "sent", sentAt: now })
        .where(eq(promoterOutreachAttempts.id, attemptId));

      await db.insert(adminActions).values({
        action: "promoter.email_sent",
        actorUserId: auth.userId,
        targetType: "promoter",
        targetId: promoter.id,
        payloadJson: JSON.stringify({
          attemptId,
          eventId: event?.id ?? null,
          to: promoter.contactEmail,
          subject: composed.subject,
          via: "mcp",
        }),
        createdAt: now,
      });

      return {
        content: [
          jsonContent({
            success: true,
            attempt_id: attemptId,
            promoter_id: promoter.id,
            promoter: promoter.companyName,
            event_id: event?.id ?? null,
            sent_to: promoter.contactEmail,
            subject: composed.subject,
            from: FROM,
          }),
        ],
      };
    }
  );

  server.tool(
    "list_promoter_outreach",
    [
      "OPE-384 — promoter confirmation asks and where each one got to.",
      "Default 'queued' shows the asks the enablement gate refused: real prose",
      "waiting on a flag, not lost. Admin only.",
    ].join(" "),
    {
      status: z
        .enum([
          "queued",
          "sent",
          "replied",
          "confirmed",
          "no_response",
          "bounced",
          "refused",
          "all",
        ])
        .optional()
        .default("queued"),
      event_id: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional().default(25),
    },
    async ({ status, event_id, limit }) => {
      const conds = [];
      if (status !== "all") conds.push(eq(promoterOutreachAttempts.status, status));
      if (event_id) conds.push(eq(promoterOutreachAttempts.eventId, event_id));
      const rows = await db
        .select({
          id: promoterOutreachAttempts.id,
          promoterId: promoterOutreachAttempts.promoterId,
          eventId: promoterOutreachAttempts.eventId,
          toAddress: promoterOutreachAttempts.toAddress,
          subject: promoterOutreachAttempts.subject,
          bodyText: promoterOutreachAttempts.bodyText,
          reason: promoterOutreachAttempts.reason,
          status: promoterOutreachAttempts.status,
          createdAt: promoterOutreachAttempts.createdAt,
          sentAt: promoterOutreachAttempts.sentAt,
          outcomeAt: promoterOutreachAttempts.outcomeAt,
        })
        .from(promoterOutreachAttempts)
        .where(conds.length > 0 ? and(...conds) : undefined)
        .orderBy(desc(promoterOutreachAttempts.createdAt))
        .limit(limit);
      return { content: [jsonContent({ count: rows.length, attempts: rows })] };
    }
  );
}
