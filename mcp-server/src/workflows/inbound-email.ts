/**
 * Inbound email orchestrator — Cloudflare Workflow.
 *
 * The Worker's email() entrypoint does only the must-be-synchronous
 * work: PostalMime parse, KV rate-limit check, intent resolution,
 * message.forward() (lifecycle-bound), inbound_emails INSERT, then
 * creates an instance of this workflow.
 *
 * Everything heavy (URL fetch, AI extract, suggest-event submit,
 * outbound reply queue, status update) lives in workflow steps —
 * each with its own retry budget and timeout, durable across Worker
 * restarts, and visible in the CF Workflows dashboard.
 *
 * Steps:
 *   1. mark-processing  — UPDATE inbound_emails SET status='processing'
 *   2. dispatch         — Per-intent handler from email-handlers/<intent>.ts
 *                         Returns HandlerResult with replyKind + status.
 *   3. send-reply       — Queue auto-reply on EMAIL_JOBS (skipped if
 *                         replyKind is null, e.g., unknown catch-all).
 *   4. mark-done        — UPDATE inbound_emails SET status, error,
 *                         workflow_instance_id (the final value, in
 *                         case the entrypoint's earlier UPDATE raced
 *                         workflow creation).
 *
 * Audit doc: docs/cloudflare-workflows-audit.md (note: that doc
 * predates this work and recommended *against* migrating the email
 * handler — the user reversed that decision once we added multi-intent
 * support, since the durable-state aspect of Workflows now actually
 * pulls its weight given the per-intent branching).
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "../db.js";
import { inboundEmails } from "../schema.js";
import { logError } from "../logger.js";
import type { EmailIntent } from "../email-intents.js";
import type { HandlerFn, HandlerResult } from "../email-handlers/types.js";
import { handle as handleSubmit } from "../email-handlers/submit.js";
import { handle as handleCorrection } from "../email-handlers/correction.js";
import { handle as handleSupport } from "../email-handlers/support.js";
import { handle as handlePress } from "../email-handlers/press.js";
import { handle as handleUnsubscribe } from "../email-handlers/unsubscribe.js";
import { handle as handleUnknown } from "../email-handlers/unknown.js";
import { buildReply } from "../email-reply-builder.js";

export type InboundEmailParams = {
  messageRowId: string;
  intent: EmailIntent;
};

type Env = {
  DB: D1Database;
  EMAIL_JOBS?: Queue<unknown>;
  MAIN_APP_URL: string;
  INTERNAL_API_KEY: string;
};

const SOURCE = "mcp:workflow:inbound-email";

/** Dispatch table — keeps the per-intent imports explicit so tree
 *  shaking sees each handler used. Adding a new intent? Add it to
 *  EmailIntent in email-intents.ts, add the file in email-handlers/,
 *  and add the row below. */
const HANDLERS: Record<EmailIntent, HandlerFn> = {
  submit: handleSubmit,
  correction: handleCorrection,
  support: handleSupport,
  press: handlePress,
  unsubscribe: handleUnsubscribe,
  unknown: handleUnknown,
};

export class InboundEmailWorkflow extends WorkflowEntrypoint<Env, InboundEmailParams> {
  async run(event: WorkflowEvent<InboundEmailParams>, step: WorkflowStep) {
    const { messageRowId, intent } = event.payload;
    const sessionId = event.instanceId;

    // Step 1: mark-processing. Tight retry — this is just a D1 UPDATE.
    await step.do(
      "mark-processing",
      { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "5 seconds" },
      async () => {
        const db = getDb(this.env.DB);
        await db
          .update(inboundEmails)
          .set({ status: "processing", workflowInstanceId: sessionId })
          .where(eq(inboundEmails.id, messageRowId));
      }
    );

    // Step 2: dispatch — call the per-intent handler. Returns
    // HandlerResult; failures inside the handler bubble out via the
    // HandlerResult.error field rather than throwing, so the step
    // itself succeeds and the workflow always reaches mark-done.
    const result: HandlerResult = await step.do(
      "dispatch",
      {
        // 60s covers the AI-extract path; non-submit intents return
        // in <1s. limit:2 = one retry on transient main-app issues.
        retries: { limit: 2, delay: "10 seconds", backoff: "constant" },
        timeout: "60 seconds",
      },
      async () => {
        // Re-read the row so the handler sees the latest state
        // (status was just flipped to 'processing' in step 1).
        const db = getDb(this.env.DB);
        const rows = await db
          .select()
          .from(inboundEmails)
          .where(eq(inboundEmails.id, messageRowId))
          .limit(1);
        if (rows.length === 0) {
          throw new Error(`inbound_emails row not found: ${messageRowId}`);
        }
        const row = rows[0];
        const handler = HANDLERS[intent];
        return await handler(this.env, { sessionId }, row);
      }
    );

    // Step 3: send-reply. Skipped if handler returned replyKind:null
    // (e.g., unknown catch-all). EMAIL_JOBS consumer in
    // queue-consumers.ts drains via env.EMAIL.send (CF Email Sending).
    if (result.replyKind !== null) {
      await step.do(
        "send-reply",
        { retries: { limit: 2, delay: "5 seconds", backoff: "constant" }, timeout: "15 seconds" },
        async () => {
          if (!this.env.EMAIL_JOBS) {
            await logError(this.env.DB, {
              level: "warn",
              source: SOURCE,
              message: "EMAIL_JOBS queue unbound; auto-reply skipped",
              sessionId,
              context: { messageRowId, intent, replyKind: result.replyKind },
            });
            return;
          }
          // We need the from_address to send TO; re-read it from the row.
          // Could pass via dispatch step's output but D1 read is cheap.
          const db = getDb(this.env.DB);
          const rows = await db
            .select({ fromAddress: inboundEmails.fromAddress })
            .from(inboundEmails)
            .where(eq(inboundEmails.id, messageRowId))
            .limit(1);
          if (rows.length === 0) {
            throw new Error(`inbound_emails row not found for reply: ${messageRowId}`);
          }
          if (result.replyKind === null) return;
          const msg = buildReply(result.replyKind, rows[0].fromAddress, result.replyParams ?? {});
          await this.env.EMAIL_JOBS.send(msg);
        }
      );
    }

    // Step 4: mark-done. Persist final status + any error from dispatch.
    await step.do(
      "mark-done",
      { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "5 seconds" },
      async () => {
        const db = getDb(this.env.DB);
        await db
          .update(inboundEmails)
          .set({
            status: result.status,
            error: result.error ?? null,
          })
          .where(eq(inboundEmails.id, messageRowId));
      }
    );

    return {
      messageRowId,
      intent,
      finalStatus: result.status,
      replyKind: result.replyKind,
      error: result.error ?? null,
    };
  }
}
