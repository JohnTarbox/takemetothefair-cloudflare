/**
 * OPE-596 — operator-initiated outbound: draft → approve → send.
 *
 * ── What was missing ─────────────────────────────────────────────────────
 * Every outbound path we had was a REPLY to something. There was no way to
 * write to a person we needed to contact — a vendor whose listing is wrong, an
 * organizer whose dates we cannot confirm — without either replying to an
 * inbound that may not exist, or publishing their address somewhere.
 *
 * ── The flag asymmetry this fixes (John's item 2) ────────────────────────
 * `EMAIL_REPLY_ENABLED` is enforced in exactly one place —
 * `queue-consumers.ts:272` — and only on messages that BOTH carry a `reply:*`
 * source AND travel the EMAIL_JOBS queue. That produced today's inverted
 * behaviour: the two paths a human reviews are gated (they use the queue) and
 * the unreviewed workflow path is not (it calls `env.EMAIL.send` directly).
 *
 * So this queue is deliberately NOT a `reply:*` source. Being caught by the
 * inbound gate would re-create the same confusion in a new place: one flag
 * silently governing two unrelated decisions. Its source is `operator:outbound`
 * and its gate is `OPERATOR_OUTBOUND_ENABLED`, checked HERE, before anything is
 * enqueued — a real check on the path, not a side effect of which transport it
 * happens to use.
 *
 * ── The guardrail ────────────────────────────────────────────────────────
 * John, authorizing the build: "build it with OPERATOR_OUTBOUND_ENABLED
 * defaulting OFF. The flip to actually enable sending is John's, made when he's
 * ready — the build going in does not by itself put mail in front of anyone."
 *
 * With the flag off, `approve` records the human decision and sends nothing.
 * That is the same shape as OPE-368's inbound semantics and for the same
 * reason: routing around an operator's stop-gate from inside the very feature
 * the gate exists to govern would encode exactly the wrong lesson.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { operatorOutboundDrafts, PENDING_REPLY_STATUS } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

/** The ledger source for this queue. NOT `reply:*` — see the header. */
export const OPERATOR_OUTBOUND_SOURCE = "operator:outbound";

export interface OperatorOutboundEnv {
  OPERATOR_OUTBOUND_ENABLED?: string;
  EMAIL_JOBS?: { send: (msg: unknown) => Promise<void> };
}

/**
 * Is delivery switched on?
 *
 * Exported and exact-matched on `"true"`, mirroring `queue-consumers.ts`. A
 * truthiness test would treat `"false"` as on, which is the single most
 * expensive way to misread a kill switch.
 */
export function operatorOutboundEnabled(env: OperatorOutboundEnv | undefined): boolean {
  return env?.OPERATOR_OUTBOUND_ENABLED === "true";
}

export function registerOperatorOutboundTools(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: OperatorOutboundEnv
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "compose_operator_email",
    "OPE-596. Draft an operator-INITIATED email to someone we need to contact — a vendor whose listing is wrong, an organizer whose dates we cannot confirm. " +
      "Unlike reply_to_inbound_email this needs no inbound message. NOTHING IS SENT: the draft is queued for human review, and delivery additionally requires OPERATOR_OUTBOUND_ENABLED, which ships off. Admin only.",
    {
      to_address: z.string().email().describe("Recipient. A real person's address — be sure."),
      subject: z.string().min(3).max(200),
      body_text: z.string().min(10).max(8000).describe("Plain text. No marketing footer."),
      reason: z
        .string()
        .min(10)
        .max(500)
        .describe(
          "WHY this is being sent, for the reviewer. Required — a draft with no stated purpose cannot be approved responsibly."
        ),
      related_entity_type: z.enum(["vendor", "promoter", "event", "venue", "other"]).optional(),
      related_entity_id: z.string().optional(),
    },
    async (params) => {
      const id = crypto.randomUUID();
      await db.insert(operatorOutboundDrafts).values({
        id,
        toAddress: params.to_address,
        subject: params.subject,
        bodyText: params.body_text,
        reason: params.reason,
        relatedEntityType: params.related_entity_type ?? null,
        relatedEntityId: params.related_entity_id ?? null,
        composedBy: auth.userId ?? "agent",
        composedAt: new Date(),
        status: PENDING_REPLY_STATUS.PENDING,
      });

      return {
        content: [
          jsonContent({
            ok: true,
            draft_id: id,
            status: "pending",
            sent: false,
            delivery_enabled: operatorOutboundEnabled(env),
            message:
              "Draft recorded. NOTHING WAS SENT. It needs a human approval, and delivery also requires OPERATOR_OUTBOUND_ENABLED='true'.",
          }),
        ],
      };
    }
  );

  server.tool(
    "list_operator_drafts",
    "OPE-596. Operator-initiated email drafts awaiting review. Each is a message somebody intends to send to a real person; none has been delivered. Read-only. Admin only.",
    {
      status: z
        .enum(["pending", "approved", "discarded", "sent"])
        .optional()
        .default("pending")
        .describe("Default 'pending' — the ones needing a decision."),
      limit: z.number().int().min(1).max(100).optional().default(25),
    },
    async (params) => {
      const rows = await db
        .select()
        .from(operatorOutboundDrafts)
        .where(eq(operatorOutboundDrafts.status, params.status ?? "pending"))
        .orderBy(asc(operatorOutboundDrafts.composedAt))
        .limit(params.limit ?? 25);

      return {
        content: [
          jsonContent({
            count: rows.length,
            delivery_enabled: operatorOutboundEnabled(env),
            gate: "OPERATOR_OUTBOUND_ENABLED must be 'true' before an approved draft is delivered",
            drafts: rows.map((r) => ({
              id: r.id,
              to: r.toAddress,
              subject: r.subject,
              reason: r.reason,
              body_text: r.bodyText,
              related: r.relatedEntityType
                ? { type: r.relatedEntityType, id: r.relatedEntityId }
                : null,
              composed_by: r.composedBy,
              composed_at: r.composedAt?.toISOString() ?? null,
              status: r.status,
              sent_at: r.sentAt?.toISOString() ?? null,
            })),
          }),
        ],
      };
    }
  );

  server.tool(
    "review_operator_draft",
    "OPE-596. Approve or discard an operator-initiated draft. On approve, the draft is DELIVERED — but only when OPERATOR_OUTBOUND_ENABLED='true'; otherwise the approval is recorded and nothing is sent. Admin only.",
    {
      id: z.string().min(8).describe("Draft id from list_operator_drafts."),
      action: z.enum(["approve", "discard"]),
      note: z.string().max(1000).optional().describe("Why — recorded on the row."),
    },
    async ({ id, action, note }) => {
      const [row] = await db
        .select()
        .from(operatorOutboundDrafts)
        .where(eq(operatorOutboundDrafts.id, id))
        .limit(1);

      if (!row) {
        return { content: [jsonContent({ ok: false, error: "not_found", id })], isError: true };
      }
      if (row.status !== PENDING_REPLY_STATUS.PENDING) {
        // Re-reviewing a settled draft would overwrite the original decision
        // and its timestamp. On a queue that SENDS on approve, it could also
        // deliver the same message twice.
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

      if (action === "discard") {
        await settle(db, id, PENDING_REPLY_STATUS.DISCARDED, auth, note);
        return {
          content: [
            jsonContent({
              ok: true,
              id,
              status: "discarded",
              sent: false,
              message: "Discarded. Retained for audit; it will not be sent.",
            }),
          ],
        };
      }

      // ── approve ──────────────────────────────────────────────────────────
      const enabled = operatorOutboundEnabled(env);
      if (!enabled || !env?.EMAIL_JOBS) {
        // Approval is a human decision and is worth recording even when
        // delivery is off — that is what lets John flip the flag and see what
        // was already agreed rather than re-reading every draft.
        await settle(db, id, PENDING_REPLY_STATUS.APPROVED, auth, note);
        return {
          content: [
            jsonContent({
              ok: true,
              id,
              status: "approved",
              sent: false,
              delivery_enabled: enabled,
              message: !enabled
                ? "Approved and recorded. NOT sent — delivery waits on OPERATOR_OUTBOUND_ENABLED='true'."
                : "Approved and recorded. NOT sent — no EMAIL_JOBS binding is available in this runtime.",
            }),
          ],
        };
      }

      // Enqueue with a source of `operator:outbound` — deliberately not
      // `reply:*`, so the inbound queue's flag does not silently govern this
      // queue too. The gate for this path was checked above.
      await env.EMAIL_JOBS.send({
        to: row.toAddress,
        subject: row.subject,
        text: row.bodyText,
        source: OPERATOR_OUTBOUND_SOURCE,
      });

      const now = new Date();
      await db
        .update(operatorOutboundDrafts)
        .set({
          status: PENDING_REPLY_STATUS.SENT,
          reviewedBy: auth.userId ?? "admin",
          reviewedAt: now,
          reviewNote: note ?? null,
          sentAt: now,
        })
        .where(
          and(
            eq(operatorOutboundDrafts.id, id),
            // Guard against a concurrent review settling it first — on a queue
            // that sends, losing this race means sending twice.
            eq(operatorOutboundDrafts.status, PENDING_REPLY_STATUS.PENDING)
          )
        );

      return {
        content: [
          jsonContent({
            ok: true,
            id,
            status: "sent",
            sent: true,
            to: row.toAddress,
            message: "Approved and enqueued for delivery.",
          }),
        ],
      };
    }
  );
}

/** Settle a draft without sending. Concurrency-guarded on `pending`. */
async function settle(
  db: Db,
  id: string,
  status: string,
  auth: AuthContext,
  note: string | undefined
) {
  await db
    .update(operatorOutboundDrafts)
    .set({
      status,
      reviewedBy: auth.userId ?? "admin",
      reviewedAt: new Date(),
      reviewNote: note ?? null,
    })
    .where(
      and(
        eq(operatorOutboundDrafts.id, id),
        eq(operatorOutboundDrafts.status, PENDING_REPLY_STATUS.PENDING)
      )
    );
}
