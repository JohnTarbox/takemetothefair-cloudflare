/**
 * OPE-954 — replay a failed inbound submission through the inbound workflow
 * WITHOUT emailing anyone.
 *
 * John approved (2026-10-04) replaying `f8ef71e5` — a 09-12 forward-as-
 * attachment that died with "Step ocr-attachments-1 output is too large" before
 * the OCR bound shipped — on one condition: the submitter must not get another
 * automated message. No such path existed: `replay_inbound_attachment` is the
 * photo lane only, and `salvage_inbound_email` notifies the submitter.
 *
 * Silence is enforced on the ROW (`replies_suppressed_reason`), not on this
 * run, because a run is not the only sender: the stale-inbound sweep re-
 * dispatches a stuck row as a normal run, and its give-up path emails the
 * submitter. Every send path asks `heldSendReason`. Held mail is ledgered as
 * `stubbed` with the reason, so the replay stays auditable.
 *
 * Order matters and is enforced: audit row → set the flag → READ IT BACK →
 * only then create the instance. A flag that did not land means no replay.
 *
 * Deliberately narrow: intent `new_event` only (other intents' handlers have
 * their own side effects this was not reviewed against), and status `failed`
 * only (a row that already produced events or replies is not a replay target).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { adminActions, inboundEmails } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

export const REPLAYABLE_INTENTS = ["new_event"] as const;
export const REPLAYABLE_STATUSES = ["failed"] as const;

export interface WorkflowCreateBinding {
  create(opts: { params: unknown; retention?: unknown }): Promise<{ id: string }>;
}

export type ReplayResult =
  | {
      ok: true;
      inboundEmailId: string;
      workflowInstanceId: string;
      repliesSuppressedReason: string;
    }
  | {
      ok: false;
      reason:
        | "not_found"
        | "intent_not_replayable"
        | "status_not_replayable"
        | "no_binding"
        | "flag_not_set";
      message: string;
    };

export async function handleReplayInbound(
  db: Db,
  binding: WorkflowCreateBinding | undefined,
  args: { inboundEmailId: string; reason: string },
  actorUserId: string | null
): Promise<ReplayResult> {
  const [row] = await db
    .select({ id: inboundEmails.id, status: inboundEmails.status, intent: inboundEmails.intent })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, args.inboundEmailId))
    .limit(1);
  if (!row) {
    return { ok: false, reason: "not_found", message: `No inbound email ${args.inboundEmailId}.` };
  }
  if (!(REPLAYABLE_INTENTS as readonly string[]).includes(row.intent ?? "")) {
    return {
      ok: false,
      reason: "intent_not_replayable",
      message: `Inbound ${row.id} has intent '${row.intent}'. Only ${REPLAYABLE_INTENTS.join(", ")} can be replayed.`,
    };
  }
  if (!(REPLAYABLE_STATUSES as readonly string[]).includes(row.status)) {
    return {
      ok: false,
      reason: "status_not_replayable",
      message: `Inbound ${row.id} is '${row.status}'. Only a '${REPLAYABLE_STATUSES.join("/")}' row is replayed.`,
    };
  }
  if (!binding) {
    return {
      ok: false,
      reason: "no_binding",
      message: "INBOUND_EMAIL workflow binding is not available here.",
    };
  }

  const suppressed = `replay: ${args.reason}`;
  await db.insert(adminActions).values({
    id: crypto.randomUUID(),
    action: "inbound.replayed",
    actorUserId,
    targetType: "inbound_email",
    targetId: row.id,
    payloadJson: JSON.stringify({ reason: args.reason, previousStatus: row.status }),
    createdAt: new Date(),
  });
  await db
    .update(inboundEmails)
    .set({ repliesSuppressedReason: suppressed })
    .where(eq(inboundEmails.id, row.id));
  // Read it back. The whole approval rests on this flag being in place BEFORE
  // the run starts; if it is not, nothing runs.
  const [check] = await db
    .select({ flag: inboundEmails.repliesSuppressedReason })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, row.id))
    .limit(1);
  if (check?.flag !== suppressed) {
    return {
      ok: false,
      reason: "flag_not_set",
      message: `Could not confirm replies_suppressed_reason on ${row.id}; NOT replaying.`,
    };
  }

  const instance = await binding.create({
    params: { messageRowId: row.id, intent: row.intent },
    retention: { successRetention: "7 days", errorRetention: "7 days" },
  });
  return {
    ok: true,
    inboundEmailId: row.id,
    workflowInstanceId: instance.id,
    repliesSuppressedReason: suppressed,
  };
}

export function registerReplayInboundEmailTool(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  binding: WorkflowCreateBinding | undefined
) {
  if (auth.role !== "ADMIN") return;
  server.tool(
    "replay_inbound_email",
    [
      "Re-run a FAILED new_event inbound submission through the inbound workflow WITHOUT emailing anyone.",
      "Sets inboundEmails.replies_suppressed_reason on the row first (read back before the run starts),",
      "so every send path, including the stale-inbound sweep and its give-up notice, holds its mail as",
      "'stubbed' in the ledger instead of sending. Creates events exactly as the original run would have.",
      "Only intent new_event and status failed. Admin only; writes an inbound.replayed audit row.",
    ].join(" "),
    {
      inbound_email_id: z.string().min(1).describe("inbound_emails.id of the failed submission."),
      reason: z
        .string()
        .min(3)
        .max(300)
        .describe("Why it is being replayed, e.g. 'OPE-954: OCR bound shipped; John approved'."),
    },
    async (params) => {
      const res = await handleReplayInbound(
        db,
        binding,
        { inboundEmailId: params.inbound_email_id, reason: params.reason },
        auth.userId ?? null
      );
      return { content: [jsonContent(res)], ...(res.ok ? {} : { isError: true }) };
    }
  );
}
