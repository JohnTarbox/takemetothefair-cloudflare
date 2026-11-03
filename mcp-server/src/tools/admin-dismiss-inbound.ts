/**
 * OPE-1251 — dismiss a parked intake workflow without sending anything.
 *
 * A mis-split demux child (the Christmas Prelude "claim_request" 198d0747 —
 * no claim language anywhere in the email) sat `waiting` on the 7-day
 * admin-decision `waitForEvent` with no way for an operator to end it:
 * reject_claim/approve_claim act on entity_claims, resolve_support_obligation
 * on obligations, get_workflow_instance is read-only. Since OPE-766 the
 * timeout sends nothing, so the harm is the week in a misleading state.
 *
 * This writes the audit row FIRST (so a failed delivery still leaves the
 * operator's intent on record), delivers `{action: "dismissed"}` to the parked
 * wait — the workflow then sends nothing and marks the row `dismissed` — and
 * sets the row's status now so it reads honestly before the instance resumes.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { adminActions, inboundEmails } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

export interface WorkflowInstanceBinding {
  get(id: string): Promise<{ sendEvent?(evt: { type: string; payload: unknown }): Promise<void> }>;
}

export type DismissResult =
  | { ok: true; inboundEmailId: string; workflowInstanceId: string; intent: string | null }
  | {
      ok: false;
      reason: "not_found" | "not_waiting" | "no_instance" | "no_binding";
      message: string;
    };

export async function handleDismissInbound(
  db: Db,
  binding: WorkflowInstanceBinding | undefined,
  args: { inboundEmailId: string; reason: string },
  actorUserId: string | null
): Promise<DismissResult> {
  const [row] = await db
    .select({
      id: inboundEmails.id,
      status: inboundEmails.status,
      intent: inboundEmails.intent,
      workflowInstanceId: inboundEmails.workflowInstanceId,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, args.inboundEmailId))
    .limit(1);
  if (!row)
    return { ok: false, reason: "not_found", message: `No inbound email ${args.inboundEmailId}.` };
  if (row.status !== "waiting") {
    return {
      ok: false,
      reason: "not_waiting",
      message: `Inbound ${row.id} is '${row.status}', not parked on an admin decision. Nothing to dismiss.`,
    };
  }
  if (!row.workflowInstanceId) {
    return {
      ok: false,
      reason: "no_instance",
      message: `Inbound ${row.id} has no workflow instance id.`,
    };
  }
  if (!binding) {
    return {
      ok: false,
      reason: "no_binding",
      message: "INBOUND_EMAIL workflow binding is not available here.",
    };
  }

  await db.insert(adminActions).values({
    id: crypto.randomUUID(),
    action: "inbound.dismissed",
    actorUserId,
    targetType: "inbound_email",
    targetId: row.id,
    payloadJson: JSON.stringify({
      reason: args.reason,
      intent: row.intent,
      workflowInstanceId: row.workflowInstanceId,
    }),
    createdAt: new Date(),
  });

  const instance = await binding.get(row.workflowInstanceId);
  if (!instance.sendEvent) {
    return {
      ok: false,
      reason: "no_binding",
      message: "Workflow instance does not accept events here.",
    };
  }
  await instance.sendEvent({
    type: "admin-decision",
    payload: { action: "dismissed", note: args.reason },
  });

  await db.update(inboundEmails).set({ status: "dismissed" }).where(eq(inboundEmails.id, row.id));

  return {
    ok: true,
    inboundEmailId: row.id,
    workflowInstanceId: row.workflowInstanceId,
    intent: row.intent ?? null,
  };
}

export function registerDismissInboundTool(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  binding: WorkflowInstanceBinding | undefined
) {
  if (auth.role !== "ADMIN") return;
  server.tool(
    "dismiss_inbound_workflow",
    "End an inbound email that is parked on the 7-day admin-decision wait (status 'waiting') WITHOUT sending anything — e.g. a mis-split demux child the sender never meant. Writes an `inbound.dismissed` audit row with your reason, delivers a 'dismissed' decision to the workflow (which then sends no reply), and marks the row status 'dismissed'. Refuses rows that are not waiting. Admin only.",
    {
      inbound_email_id: z.string().min(1).describe("inbound_emails.id of the waiting row"),
      reason: z
        .string()
        .min(3)
        .max(500)
        .describe("Why it is being dismissed (recorded in the audit row)."),
    },
    async (params) => {
      const r = await handleDismissInbound(
        db,
        binding,
        { inboundEmailId: params.inbound_email_id, reason: params.reason },
        auth.userId ?? null
      );
      return r.ok
        ? { content: [jsonContent({ dismissed: true, sent: false, ...r })] }
        : {
            content: [jsonContent({ dismissed: false, error: r.reason, message: r.message })],
            isError: true,
          };
    }
  );
}
