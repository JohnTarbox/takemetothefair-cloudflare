/**
 * OPE-368 (R4) — the operator's side of the reply gate.
 *
 * Before this, an agent that had composed an answer for a waiting customer had
 * no way to say *"I have a reply ready, please approve it."* The refusal was
 * terminal and mute. These tools are that missing half: the drafts the gate
 * refused are listable, readable and actionable.
 *
 * ── On `approve` deliberately not sending ───────────────────────────────────
 * Approving records the human decision and nothing more. Delivery still
 * respects EMAIL_REPLY_ENABLED.
 *
 * That is a deliberate refusal to build the obvious feature. An "approve and
 * send anyway" button inside the very capability an operator gated off would
 * route around the stop-gate from within — and the admin MCP token is held by
 * agents, so it would not even require a human. The flag exists to stop
 * unattended free-form prose reaching customers; a tool that can lift it on its
 * own authority does not respect it, it launders it.
 *
 * So approved drafts wait. `discard` is fully terminal.
 *
 * ── OPE-635: what that paragraph used to claim, and did not do ──────────────
 * It used to end *"and go out when John flips the flag."* They do not. NOTHING
 * DRAINS THIS QUEUE. A reply approved on 2026-08-17 sat undelivered for 13
 * days; `EMAIL_REPLY_ENABLED` was set true on 2026-08-30 and nothing flushed,
 * because there is no flusher — verified in `email_send_ledger` before and
 * after the flag change.
 *
 * The design is still right: approval records a decision, and an
 * approve-and-send path inside a gated capability would launder the gate. What
 * was wrong was describing manual delivery as automatic, which is worse than
 * either behaviour on its own — a reviewer who approved a draft had every
 * reason to believe the customer would receive it. The wording now says what
 * happens. Whether to build the drain is John's call, not this tool's.
 *
 * ── `superseded`: the exit `approved` never had ─────────────────────────────
 * A draft delivered by another route had nowhere to go. Settled drafts were not
 * re-reviewable at all, so the row stayed `approved` forever — a duplicate-send
 * hazard for whatever drain gets built later. Closing one out required a raw D1
 * UPDATE around this state machine.
 *
 * `supersede` is re-review in the ONE safe direction: toward closure, never
 * back toward sending. And it cannot be asserted — it is reconciled against
 * `email_send_ledger`, so a draft can only be marked delivered-elsewhere when
 * the ledger agrees something actually went out for that inbound.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  pendingEmailReplies,
  inboundEmails,
  emailSendLedger,
  PENDING_REPLY_STATUS,
} from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

/**
 * OPE-635 — which statuses an action may act on.
 *
 * Exported because it is the whole state machine, and a state machine that only
 * exists inside a tool handler cannot be tested. The asymmetry is the point:
 * `approve`/`discard` stay pending-only so a settled decision and its timestamp
 * are never overwritten, while `supersede` is reachable from `approved` because
 * that was the trap — approving a draft was what removed your ability to close
 * it out, leaving a permanent duplicate-send hazard.
 *
 * Nothing here returns a row to `pending`. Re-review is allowed toward closure
 * only, never back toward sending.
 */
export function allowedFromStatuses(
  action: "approve" | "discard" | "supersede"
): readonly string[] {
  return action === "supersede"
    ? [PENDING_REPLY_STATUS.PENDING, PENDING_REPLY_STATUS.APPROVED]
    : [PENDING_REPLY_STATUS.PENDING];
}

/** A candidate discharging send, newest first. */
export interface LedgerSend {
  messageId: string;
}

export type DischargeResolution =
  | { ok: true; messageId: string }
  | { ok: false; error: "no_matching_send" }
  | { ok: false; error: "message_id_not_in_ledger" };

/**
 * OPE-635 §4 — decide which send discharged a draft, or refuse.
 *
 * "This was delivered by another path" is a claim about the world, so it is
 * checked against the world. `sends` must already be filtered to `status='sent'`
 * rows for the SAME inbound, newest first: a `failed` or `stubbed` ledger row
 * means the customer received nothing, and treating one as a discharge would
 * close out a draft that still owes somebody an answer.
 *
 * Requiring this now, before any drain exists, is deliberate — it means a
 * `superseded` row always carries the message that actually discharged it, so
 * whatever drain gets built later has a trustworthy set to skip.
 */
export function resolveDischargingSend(
  sends: readonly LedgerSend[],
  requestedId?: string
): DischargeResolution {
  if (sends.length === 0) return { ok: false, error: "no_matching_send" };
  if (requestedId) {
    return sends.some((x) => x.messageId === requestedId)
      ? { ok: true, messageId: requestedId }
      : { ok: false, error: "message_id_not_in_ledger" };
  }
  return { ok: true, messageId: sends[0].messageId };
}

export function registerPendingReplyTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "list_pending_replies",
    [
      "OPE-368 — replies that were composed for a customer and REFUSED by the",
      "EMAIL_REPLY_ENABLED gate. Each row is a real answer somebody wrote that has not",
      "reached the person waiting for it.",
      "",
      "Before this existed the prose was discarded at the moment of refusal and nothing",
      "recorded the attempt. Use it to see what is waiting, then review_pending_reply to",
      "approve or discard. Admin only.",
    ].join(" "),
    {
      status: z
        .enum(["pending", "approved", "discarded", "sent", "superseded", "all"])
        .optional()
        .default("pending")
        .describe("Filter by status. Default 'pending' — what is waiting on a human."),
      limit: z.number().int().min(1).max(100).optional().default(25),
    },
    async ({ status, limit }) => {
      const rows = await db
        .select({
          id: pendingEmailReplies.id,
          inboundEmailId: pendingEmailReplies.inboundEmailId,
          toAddress: pendingEmailReplies.toAddress,
          subject: pendingEmailReplies.subject,
          bodyText: pendingEmailReplies.bodyText,
          requestedBy: pendingEmailReplies.requestedBy,
          requestedAt: pendingEmailReplies.requestedAt,
          status: pendingEmailReplies.status,
          reviewedBy: pendingEmailReplies.reviewedBy,
          reviewNote: pendingEmailReplies.reviewNote,
          inboundSubject: inboundEmails.subject,
          inboundFrom: inboundEmails.fromAddress,
        })
        .from(pendingEmailReplies)
        .leftJoin(inboundEmails, eq(inboundEmails.id, pendingEmailReplies.inboundEmailId))
        .where(status === "all" ? undefined : eq(pendingEmailReplies.status, status))
        .orderBy(asc(pendingEmailReplies.requestedAt))
        .limit(limit);

      return {
        content: [
          jsonContent({
            count: rows.length,
            // Stated on every response so the reason these exist is never a
            // mystery to whoever is reading the list.
            gate: "EMAIL_REPLY_ENABLED must be 'true' before any of these can be delivered",
            replies: rows,
          }),
        ],
      };
    }
  );

  server.tool(
    "review_pending_reply",
    [
      "OPE-368/OPE-635 — act on a refused reply draft.",
      "",
      "approve: records the human decision. It does NOT send, and NOTHING ELSE SENDS IT",
      "EITHER — there is no drain, so delivery remains MANUAL via reply_to_inbound_email.",
      "(This tool used to claim approved drafts go out when EMAIL_REPLY_ENABLED is on.",
      "They do not: one sat 13 days, and the flag going true flushed nothing.)",
      "An approve-and-send path inside a capability an operator gated off would route",
      "around that gate on the tool's own authority, so approve stays a record, not a send.",
      "",
      "discard: terminal, will never be sent.",
      "",
      "supersede: this draft was already delivered by another path. Terminal, and the ONLY",
      "transition out of 'approved'. Requires a real send in email_send_ledger for the same",
      "inbound — pass sent_message_id, or omit it and the most recent matching send is used.",
      "If the ledger shows no send, this is refused: a draft cannot be declared delivered",
      "on an operator's say-so. Admin only.",
    ].join(" "),
    {
      id: z.string().min(8).describe("Draft id from list_pending_replies."),
      action: z.enum(["approve", "discard", "supersede"]),
      note: z.string().max(1000).optional().describe("Why — recorded on the row."),
      sent_message_id: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "supersede only: the email_send_ledger message_id that discharged this draft. " +
            "Omit to use the most recent 'sent' ledger row for the same inbound."
        ),
    },
    async ({ id, action, note, sent_message_id }) => {
      const [row] = await db
        .select({
          id: pendingEmailReplies.id,
          status: pendingEmailReplies.status,
          inboundEmailId: pendingEmailReplies.inboundEmailId,
        })
        .from(pendingEmailReplies)
        .where(eq(pendingEmailReplies.id, id))
        .limit(1);

      if (!row) {
        return { content: [jsonContent({ ok: false, error: "not_found", id })], isError: true };
      }
      // OPE-635 — which transitions are legal.
      //
      // approve/discard stay pending-only: re-reviewing a settled draft would
      // overwrite the original decision and its timestamp, and the audit trail
      // matters more than the convenience.
      //
      // supersede is the exception, and only in the direction of CLOSURE. It is
      // reachable from `approved` because that was the trap: approving a draft
      // was what removed your ability to clean it up, so a row delivered by
      // another route stayed `approved` forever as a duplicate-send hazard.
      // It never moves a row back toward sending.
      const isSupersede = action === "supersede";
      const allowedFrom = allowedFromStatuses(action);

      if (!allowedFrom.includes(row.status)) {
        return {
          content: [
            jsonContent({
              ok: false,
              error: "already_reviewed",
              id,
              status: row.status,
              message:
                row.status === PENDING_REPLY_STATUS.APPROVED
                  ? `Draft is 'approved'. Use action:"supersede" to close it out if it was delivered by another path.`
                  : `Draft is already '${row.status}'. Settled drafts are not re-reviewable.`,
            }),
          ],
          isError: true,
        };
      }

      // OPE-635 §4 — reconcile on the way in.
      //
      // "This was delivered elsewhere" is a claim about the world, so it is
      // checked against the world rather than taken on the caller's word. The
      // ledger is the only reliable answer-oracle here, and requiring it now
      // means the invariant is enforced before any drain exists to need it —
      // a superseded row always carries the message that actually discharged it.
      let dischargedBy: string | null = null;
      if (isSupersede) {
        const sends = await db
          .select({ messageId: emailSendLedger.messageId, sentAt: emailSendLedger.sentAt })
          .from(emailSendLedger)
          .where(
            and(
              eq(emailSendLedger.inboundEmailId, row.inboundEmailId),
              // Only a real delivery discharges a draft. A 'failed' or 'stubbed'
              // row means the customer got nothing.
              eq(emailSendLedger.status, "sent")
            )
          )
          .orderBy(desc(emailSendLedger.sentAt))
          .limit(50);

        const resolved = resolveDischargingSend(sends, sent_message_id);
        if (!resolved.ok && resolved.error === "no_matching_send") {
          return {
            content: [
              jsonContent({
                ok: false,
                error: "no_matching_send",
                id,
                inbound_email_id: row.inboundEmailId,
                message:
                  "email_send_ledger shows no successful send for this inbound, so this draft " +
                  "cannot be marked superseded. If the reply genuinely has not gone out, send " +
                  "it with reply_to_inbound_email; if it should never go out, use discard.",
              }),
            ],
            isError: true,
          };
        }
        if (!resolved.ok) {
          return {
            content: [
              jsonContent({
                ok: false,
                error: "message_id_not_in_ledger",
                id,
                sent_message_id,
                candidates: sends.slice(0, 5).map((x) => x.messageId),
                message:
                  "That message_id has no 'sent' ledger row against this inbound. Pass one of " +
                  "the candidates, or omit sent_message_id to use the most recent.",
              }),
            ],
            isError: true,
          };
        }
        dischargedBy = resolved.messageId;
      }

      const next = isSupersede
        ? PENDING_REPLY_STATUS.SUPERSEDED
        : action === "approve"
          ? PENDING_REPLY_STATUS.APPROVED
          : PENDING_REPLY_STATUS.DISCARDED;
      await db
        .update(pendingEmailReplies)
        .set({
          status: next,
          reviewedBy: auth.userId ?? "admin",
          reviewedAt: new Date(),
          reviewNote: note ?? null,
          ...(dischargedBy ? { sentMessageId: dischargedBy } : {}),
        })
        .where(
          and(
            eq(pendingEmailReplies.id, id),
            // Guard against a concurrent review settling it first.
            inArray(pendingEmailReplies.status, [...allowedFrom])
          )
        );

      return {
        content: [
          jsonContent({
            ok: true,
            id,
            status: next,
            sent: false,
            ...(dischargedBy ? { sent_message_id: dischargedBy } : {}),
            message:
              action === "approve"
                ? "Approved and recorded. NOT sent — and nothing else will send it: there is no " +
                  "drain. Deliver it with reply_to_inbound_email, then close this row out with " +
                  'action:"supersede".'
                : action === "discard"
                  ? "Discarded. The draft is retained for audit but will not be sent."
                  : "Superseded — closed out against a confirmed send. It will never be sent again.",
          }),
        ],
      };
    }
  );
}
