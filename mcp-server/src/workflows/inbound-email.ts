/**
 * Inbound email orchestrator — Cloudflare Workflow.
 *
 * The Worker's email() entrypoint does only the must-be-synchronous
 * work: PostalMime parse, KV rate-limit check, intent resolution,
 * message.forward() (lifecycle-bound), inbound_emails INSERT, then
 * creates an instance of this workflow.
 *
 * Everything heavy (URL fetch, AI extract, suggest-event submit,
 * outbound reply send, status update) lives in workflow steps — each
 * with its own retry budget and timeout, durable across Worker restarts,
 * and visible in the CF Workflows dashboard.
 *
 * Step structure depends on intent:
 *
 *   intent=submit  (orchestrated in run, not via HANDLERS):
 *     1. mark-processing
 *     2. submit/load-row        — D1 read of inbound_emails row
 *     3. submit/fetch-url       — external HTTP, retried 3× on 5xx
 *     4. submit/ai-extract      — Workers AI, NonRetryableError on fail
 *     5. submit/submit-event    — main-app POST, retried 3× on 5xx
 *     6. send-reply             — env.EMAIL.send direct, retried 3×
 *     7. mark-done
 *
 *   intent=correction | press  (human-in-the-loop):
 *     1. mark-processing
 *     2. dispatch               — calls HANDLERS[intent] (inserts admin row)
 *     3. mark-waiting           — status='waiting'
 *     4. waitForEvent           — admin-decision, 7-day timeout (durable
 *                                 pause; instance hibernates and resumes
 *                                 on event or timeout)
 *     5. send-reply             — tailored to decision (or generic on timeout)
 *     6. mark-done
 *
 *   other intents (support / unsubscribe / unknown):
 *     1. mark-processing
 *     2. dispatch               — calls HANDLERS[intent] (throws on fail)
 *     3. send-reply             — skipped if replyKind:null
 *     4. mark-done
 *
 * Failure contract: handlers and submit-leg functions THROW on failure.
 * Plain Error triggers the step's retry budget; NonRetryableError from
 * `cloudflare:workflows` short-circuits retries for permanent failures.
 * The workflow's outer try/catch wraps the dispatch / submit-pipeline
 * block, maps caught errors to a generic-failure reply kind, and writes
 * status='failed' + error message to inbound_emails in mark-done.
 *
 * Retention: 7 days. Long enough to debug a failure cluster, short
 * enough to keep instance storage costs flat as volume grows. Override
 * per-instance via the `.create({ retention })` call site if needed.
 *
 * Audit doc: docs/cloudflare-workflows-audit.md.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { eq } from "drizzle-orm";
import { getDb } from "../db.js";
import { inboundEmails } from "../schema.js";
import { logError } from "../logger.js";
import type { EmailIntent } from "../email-intents.js";
import type { HandlerFn, HandlerResult, ReplyKind } from "../email-handlers/types.js";
import { handle as handleCorrection } from "../email-handlers/correction.js";
import { handle as handleSupport } from "../email-handlers/support.js";
import { handle as handlePress } from "../email-handlers/press.js";
import { handle as handleUnsubscribe } from "../email-handlers/unsubscribe.js";
import { handle as handleUnknown } from "../email-handlers/unknown.js";
import {
  submitFetch,
  submitExtract,
  submitCheckDuplicate,
  submitEvent,
} from "../email-handlers/submit.js";
import { buildReply } from "../email-reply-builder.js";

export type InboundEmailParams = {
  messageRowId: string;
  intent: EmailIntent;
};

type Env = {
  DB: D1Database;
  /** Cloudflare Email Service outbound binding. Replaces the prior
   *  EMAIL_JOBS queue hop for 1:1 auto-replies — Workflow steps already
   *  give the durability the queue intermediate was providing. */
  EMAIL?: SendEmail;
  MAIN_APP_URL: string;
  INTERNAL_API_KEY: string;
};

const SOURCE = "mcp:workflow:inbound-email";
const DEFAULT_FROM = "Meet Me at the Fair <notify@meetmeatthefair.com>";

/** Dispatch table for non-submit intents. Submit is orchestrated
 *  directly in run() because its three external calls each need to
 *  be a separate checkpointed step. */
const HANDLERS: Record<Exclude<EmailIntent, "submit">, HandlerFn> = {
  correction: handleCorrection,
  support: handleSupport,
  press: handlePress,
  unsubscribe: handleUnsubscribe,
  unknown: handleUnknown,
};

/** Map an error message thrown by a submit-leg or handler to a user-
 *  visible reply kind. Submit-specific kinds for submit-intent errors,
 *  null for everything else (admin already saw the forwarded message). */
function errorToReplyKind(intent: EmailIntent, errMsg: string): ReplyKind | null {
  if (intent === "submit") {
    if (errMsg.startsWith("submit-")) return "submit-failed";
    return "extract-failed";
  }
  return null;
}

/** Map an admin decision to a tailored reply kind. Decision shape is
 *  sent from the admin UI via `instance.sendEvent({type:"admin-decision",
 *  payload})`. Null decision = waitForEvent timed out; fall back to the
 *  generic ack so the sender doesn't go forever without acknowledgement. */
function decisionToReplyKind(
  intent: "correction" | "press",
  decision: AdminDecision | null
): ReplyKind {
  if (decision === null) {
    return intent === "correction" ? "correction-ack" : "press-ack";
  }
  if (intent === "correction") {
    switch (decision.action) {
      case "applied":
        return "correction-applied";
      case "rejected":
        return "correction-rejected";
      case "needs-more-info":
        return "correction-needs-info";
      default:
        return "correction-ack";
    }
  }
  switch (decision.action) {
    case "applied":
      return "press-handled";
    case "needs-more-info":
      return "press-needs-info";
    default:
      return "press-ack";
  }
}

/** Shape of the payload sent via instance.sendEvent for correction/press
 *  intents. The MCP endpoint at /api/admin/inbound-emails/:id/decide
 *  produces this; the admin UI's action buttons drive it. */
interface AdminDecision {
  action: "applied" | "rejected" | "needs-more-info";
  note?: string;
}

export class InboundEmailWorkflow extends WorkflowEntrypoint<Env, InboundEmailParams> {
  async run(event: WorkflowEvent<InboundEmailParams>, step: WorkflowStep) {
    const { messageRowId, intent } = event.payload;
    const sessionId = event.instanceId;

    // ───── Step 1: mark-processing ──────────────────────────────────
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

    // ───── Step 2: dispatch (per-intent) ────────────────────────────
    let result: HandlerResult;
    let caughtError: string | null = null;

    try {
      if (intent === "submit") {
        result = await this.runSubmitPipeline(step, messageRowId);
      } else {
        result = await step.do(
          "dispatch",
          {
            retries: { limit: 2, delay: "10 seconds", backoff: "constant" },
            timeout: "30 seconds",
          },
          async () => {
            const db = getDb(this.env.DB);
            const rows = await db
              .select()
              .from(inboundEmails)
              .where(eq(inboundEmails.id, messageRowId))
              .limit(1);
            if (rows.length === 0) {
              throw new NonRetryableError(`inbound_emails row not found: ${messageRowId}`);
            }
            return await HANDLERS[intent](this.env, { sessionId }, rows[0]);
          }
        );
      }
    } catch (err) {
      caughtError = err instanceof Error ? err.message : String(err);
      result = {
        replyKind: errorToReplyKind(intent, caughtError),
        status: "replied",
      };
      await logError(this.env.DB, {
        source: SOURCE,
        message: `dispatch failed for intent=${intent}`,
        sessionId,
        context: { messageRowId, intent, error: caughtError },
      });
    }

    // ───── Optional: human-in-the-loop pause (correction/press) ─────
    // Only runs when dispatch succeeded (no caughtError) — a failed
    // dispatch means we never recorded the admin_actions row, so there's
    // nothing for admin to decide on. The waitForEvent is durable; the
    // workflow hibernates here and resumes when sendEvent fires or the
    // 7-day timeout elapses, whichever comes first.
    if (!caughtError && (intent === "correction" || intent === "press")) {
      await step.do(
        "mark-waiting",
        { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "5 seconds" },
        async () => {
          const db = getDb(this.env.DB);
          await db
            .update(inboundEmails)
            .set({ status: "waiting" })
            .where(eq(inboundEmails.id, messageRowId));
        }
      );

      let decision: AdminDecision | null = null;
      try {
        // step.waitForEvent returns a WorkflowStepEvent<T> wrapper
        // (`{payload, type, timestamp}`); we only care about the payload
        // shape sent via instance.sendEvent in handleInboundEmailsApi.
        const evt = await step.waitForEvent<AdminDecision>("admin-decision", {
          type: "admin-decision",
          timeout: "7 days",
        });
        decision = evt.payload as AdminDecision;
      } catch {
        // Timeout — falls through with decision=null, generic ack reply.
        decision = null;
      }

      result = {
        replyKind: decisionToReplyKind(intent, decision),
        replyParams: decision?.note ? { note: decision.note } : undefined,
        status: "replied",
      };
    }

    // ───── Step 3: send-reply (skipped if replyKind null) ───────────
    if (result.replyKind !== null) {
      const replyKind = result.replyKind;
      const replyParams = result.replyParams ?? {};
      await step.do(
        "send-reply",
        {
          retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
          timeout: "10 seconds",
        },
        async () => {
          if (!this.env.EMAIL) {
            // No binding in this env (dev / unconfigured). Log + skip
            // rather than throw — losing an auto-reply isn't worth
            // marking the whole workflow failed.
            await logError(this.env.DB, {
              level: "warn",
              source: SOURCE,
              message: "EMAIL binding unbound; auto-reply skipped",
              sessionId,
              context: { messageRowId, intent, replyKind },
            });
            return;
          }
          const db = getDb(this.env.DB);
          const rows = await db
            .select({
              fromAddress: inboundEmails.fromAddress,
              subject: inboundEmails.subject,
            })
            .from(inboundEmails)
            .where(eq(inboundEmails.id, messageRowId))
            .limit(1);
          if (rows.length === 0) {
            throw new NonRetryableError(`inbound_emails row not found for reply: ${messageRowId}`);
          }
          // Use replyParams.subject if the handler provided one (e.g.,
          // submit pipeline's success path); otherwise fall back to the
          // row's subject (covers the dispatch-failed synthetic-result
          // path, where the handler threw before populating params).
          const params =
            "subject" in replyParams
              ? replyParams
              : { ...replyParams, subject: rows[0].subject ?? "" };
          const msg = buildReply(replyKind, rows[0].fromAddress, params);
          await this.env.EMAIL.send({
            from: msg.from ?? DEFAULT_FROM,
            to: msg.to,
            subject: msg.subject,
            html: msg.html,
            text: msg.text,
          });
        }
      );
    }

    // ───── Step 4: mark-done ────────────────────────────────────────
    // Persist final status + reply attribution (reply_kind +
    // resulting_event_id, drizzle/0076) + fetch path (fetch_method,
    // drizzle/0078) so /admin/inbound-emails and the sender-quality
    // summary can attribute dedup hits separately from no-URL fallbacks,
    // and so post-deploy analytics can measure Browser Rendering hit rate.
    //
    // fetchMethod nuance: only set when the submit pipeline reached the
    // dedup or final-ok branches (both attach fetched.fetchMethod). When
    // the fetch step itself failed and the outer catch fired, result
    // doesn't carry fetchMethod — we infer 'failed' from the error
    // prefix so the analytics query still counts the both-paths-failed
    // cohort. Other failure modes (extract/submit) leave fetch_method
    // NULL because we don't know which fetch path got us here.
    const inferredFetchMethod =
      caughtError && caughtError.startsWith("fetch-") ? "failed" : (result.fetchMethod ?? null);
    await step.do(
      "mark-done",
      { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "5 seconds" },
      async () => {
        const db = getDb(this.env.DB);
        await db
          .update(inboundEmails)
          .set({
            status: caughtError ? "failed" : result.status,
            error: caughtError ?? null,
            replyKind: result.replyKind ?? null,
            resultingEventId: result.resultingEventId ?? null,
            fetchMethod: inferredFetchMethod,
          })
          .where(eq(inboundEmails.id, messageRowId));
      }
    );

    return {
      messageRowId,
      intent,
      finalStatus: caughtError ? ("failed" as const) : result.status,
      replyKind: result.replyKind,
      error: caughtError,
    };
  }

  /**
   * Submit-intent pipeline: three external calls as three checkpointed
   * steps. Each leg throws Error (retryable) or NonRetryableError
   * (permanent). The caller's try/catch handles the throw.
   *
   * Missing-URL case is handled here (early return with "no-url" reply)
   * rather than throwing, because there's nothing to retry — the sender
   * just didn't include a link.
   */
  private async runSubmitPipeline(
    step: WorkflowStep,
    messageRowId: string
  ): Promise<HandlerResult> {
    const rowSnapshot = await step.do(
      "submit/load-row",
      { retries: { limit: 2, delay: "5 seconds", backoff: "constant" }, timeout: "5 seconds" },
      async () => {
        const db = getDb(this.env.DB);
        const rows = await db
          .select({
            parsedUrl: inboundEmails.parsedUrl,
            fromAddress: inboundEmails.fromAddress,
            subject: inboundEmails.subject,
            attachmentCount: inboundEmails.attachmentCount,
          })
          .from(inboundEmails)
          .where(eq(inboundEmails.id, messageRowId))
          .limit(1);
        if (rows.length === 0) {
          throw new NonRetryableError(`inbound_emails row not found: ${messageRowId}`);
        }
        return rows[0];
      }
    );

    const subject = rowSnapshot.subject ?? "";

    if (!rowSnapshot.parsedUrl) {
      return {
        replyKind: "no-url",
        replyParams: { subject, hasAttachments: rowSnapshot.attachmentCount > 0 },
        status: "replied",
      };
    }

    const url = rowSnapshot.parsedUrl;

    const fetched = await step.do(
      "submit/fetch-url",
      // 30s timeout (was 20s before A5) — Browser Rendering's managed
      // headless Chrome can take 5–15s on first-cold-Chrome on top of the
      // standard fetch's own 15s budget. drizzle/0078 tracks which path won.
      { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "30 seconds" },
      () => submitFetch(this.env, url)
    );

    const extracted = await step.do(
      "submit/ai-extract",
      // limit:1 — audit doc found Workers AI load-timeouts don't recover
      // on tight retries; submitExtract throws NonRetryableError anyway.
      { retries: { limit: 1, delay: "10 seconds", backoff: "constant" }, timeout: "30 seconds" },
      () => submitExtract(this.env, fetched)
    );

    // Duplicate-check before insert. Two-stage (exact source_url, then
    // name+date similarity ≥0.85 within ±7d) — sender of an already-
    // listed event gets the tailored "already-exists" reply pointing at
    // our existing listing instead of producing a redundant PENDING row.
    // Fails open: on transient dedup-endpoint failures the step retries
    // twice then falls through to submit (same risk profile as the
    // pre-2026-05-18 behavior).
    const dedup = await step.do(
      "submit/check-duplicate",
      { retries: { limit: 2, delay: "5 seconds", backoff: "constant" }, timeout: "10 seconds" },
      () => submitCheckDuplicate(this.env, extracted)
    );

    if (dedup.isDuplicate && dedup.existingEventSlug) {
      return {
        replyKind: "already-exists",
        replyParams: {
          subject,
          eventName: dedup.existingEventName ?? extracted.event.name,
          eventUrl: `https://meetmeatthefair.com/events/${dedup.existingEventSlug}`,
          matchType: dedup.matchType ?? "exact_url",
        },
        status: "replied",
        // Persist the matched existing event id so /admin/inbound-emails
        // can render a "matched against X" link without a JOIN.
        resultingEventId: dedup.existingEventId ?? null,
        fetchMethod: fetched.fetchMethod,
      };
    }

    const submitted = await step.do(
      "submit/submit-event",
      { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "15 seconds" },
      () => submitEvent(this.env, extracted, rowSnapshot.fromAddress)
    );

    return {
      replyKind: "ok",
      replyParams: {
        subject,
        eventName: submitted.eventName,
        hasAttachments: rowSnapshot.attachmentCount > 0,
      },
      status: "replied",
      // Persist the newly-created event id for the same admin-UI link.
      resultingEventId: submitted.id,
      fetchMethod: fetched.fetchMethod,
    };
  }
}
