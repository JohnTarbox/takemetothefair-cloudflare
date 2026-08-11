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
 * So approved drafts wait, and go out when John flips the flag. `discard` is
 * fully terminal, which is the end-to-end path an operator can complete today.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { pendingEmailReplies, inboundEmails, PENDING_REPLY_STATUS } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

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
        .enum(["pending", "approved", "discarded", "sent", "all"])
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
      "OPE-368 — act on a refused reply draft: approve it (records the decision; delivery",
      "still waits for EMAIL_REPLY_ENABLED) or discard it.",
      "",
      "Approve deliberately does NOT send. An approve-and-send path inside a capability an",
      "operator has gated off would route around that gate on the tool's own authority.",
      "Approved drafts go out when the flag is enabled. Admin only.",
    ].join(" "),
    {
      id: z.string().min(8).describe("Draft id from list_pending_replies."),
      action: z.enum(["approve", "discard"]),
      note: z.string().max(1000).optional().describe("Why — recorded on the row."),
    },
    async ({ id, action, note }) => {
      const [row] = await db
        .select({ id: pendingEmailReplies.id, status: pendingEmailReplies.status })
        .from(pendingEmailReplies)
        .where(eq(pendingEmailReplies.id, id))
        .limit(1);

      if (!row) {
        return { content: [jsonContent({ ok: false, error: "not_found", id })], isError: true };
      }
      if (row.status !== PENDING_REPLY_STATUS.PENDING) {
        // Re-reviewing a settled draft would overwrite the original decision
        // and its timestamp — the audit trail matters more than convenience.
        return {
          content: [
            jsonContent({
              ok: false,
              error: "already_reviewed",
              id,
              status: row.status,
              message: `Draft is already '${row.status}'. Settled drafts are not re-reviewable.`,
            }),
          ],
          isError: true,
        };
      }

      const next =
        action === "approve" ? PENDING_REPLY_STATUS.APPROVED : PENDING_REPLY_STATUS.DISCARDED;
      await db
        .update(pendingEmailReplies)
        .set({
          status: next,
          reviewedBy: auth.userId ?? "admin",
          reviewedAt: new Date(),
          reviewNote: note ?? null,
        })
        .where(
          and(
            eq(pendingEmailReplies.id, id),
            // Guard against a concurrent review settling it first.
            eq(pendingEmailReplies.status, PENDING_REPLY_STATUS.PENDING)
          )
        );

      return {
        content: [
          jsonContent({
            ok: true,
            id,
            status: next,
            sent: false,
            message:
              action === "approve"
                ? "Approved and recorded. NOT sent — delivery waits on EMAIL_REPLY_ENABLED."
                : "Discarded. The draft is retained for audit but will not be sent.",
          }),
        ],
      };
    }
  );
}
