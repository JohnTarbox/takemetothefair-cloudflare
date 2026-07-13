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
import { ledgerEmailSend } from "../mailer.js";
import { inboundEmails, adminActions, events } from "../schema.js";
import { logError } from "../logger.js";
import { classifyDomainTier, isHigherTier, classifyDedupTier } from "@takemetothefair/utils";
import type { EmailIntent } from "../email-intents.js";
import type { HandlerFn, HandlerResult, ReplyKind } from "../email-handlers/types.js";
import { handle as handleCorrection } from "../email-handlers/correction.js";
import { handle as handleSupport } from "../email-handlers/support.js";
import { handle as handleProblemReport } from "../email-handlers/problem-report.js";
import { handle as handlePress } from "../email-handlers/press.js";
import { handle as handleUnsubscribe } from "../email-handlers/unsubscribe.js";
import { handle as handleUnknown } from "../email-handlers/unknown.js";
import { handle as handleSpam } from "../email-handlers/spam.js";
import { handle as handleSourceSuggestion } from "../email-handlers/source-suggestion.js";
import { extractAllUrls, type AttachmentRef } from "../email-handler.js";
import {
  submitFetch,
  submitExtract,
  submitFreeTextExtract,
  submitCheckDuplicate,
  submitEvent,
  stripSignature,
  stripForwardedPreamble,
  type SubmitFetchResult,
} from "../email-handlers/submit.js";
import { recordSourceCitations } from "../email-handlers/pipeline-citations.js";
import { computeFillEmptyProposals } from "../email-handlers/enrich-proposal.js";
import { detectRosterNames } from "../email-handlers/roster-detect.js";
import { buildReply } from "../email-reply-builder.js";
import { issueToken } from "../feedback-tokens.js";
import { issueCorrectionToken } from "../correction-tokens.js";
import { seedDiscoveryCandidate } from "../goodwill/seed-discovery.js";

export type InboundEmailParams = {
  messageRowId: string;
  intent: EmailIntent;
};

/**
 * OPE-55 Phase 1 — a single event-shaped SOURCE for the unified
 * multi-source fan-out. Either the email's body prose (`body`) or one
 * body-linked URL (`url`). The submit pipeline builds a list of these
 * (URLs first, body last — see runSubmitPipeline) and fans out over them
 * so an email carrying events across BOTH a URL and its body text yields
 * every distinct event, not just one branch's.
 */
type SubmitSource =
  | { kind: "body"; text: string }
  | { kind: "url"; url: string }
  // OPE-68 — an OCR'd poster/PDF attachment. `text` is the markdown produced
  // by env.AI.toMarkdown; `name` is the attachment filename (for the reply
  // bullet); `imageKey` is the R2 key of the stored poster when the source was
  // an image (used to set the created event's hero image). Treated like a
  // `body` source for extraction (submitFreeTextExtract over `text`).
  | { kind: "attachment"; text: string; name: string; imageKey?: string };

type Env = {
  DB: D1Database;
  /** Cloudflare Email Service outbound binding. Replaces the prior
   *  EMAIL_JOBS queue hop for 1:1 auto-replies — Workflow steps already
   *  give the durability the queue intermediate was providing. */
  EMAIL?: SendEmail;
  MAIN_APP_URL: string;
  INTERNAL_API_KEY: string;
  /** OPE-68 — Workers AI binding. Used for env.AI.toMarkdown to OCR stored
   *  poster/PDF attachments into markdown text. Optional so tests / non-AI
   *  envs can omit it (OCR then contributes no attachment sources). */
  AI?: Ai;
  /** OPE-68 — shared vendor-assets R2 bucket. The email() entrypoint stored
   *  the attachment bytes here at receive-time; the OCR step reads them back.
   *  Optional so tests / non-R2 envs can omit it. */
  VENDOR_ASSETS?: R2Bucket;
};

const SOURCE = "mcp:workflow:inbound-email";
const DEFAULT_FROM = "Meet Me at the Fair <notify@meetmeatthefair.com>";
// OPE-68 — minimum OCR markdown length (after trim) for an attachment to be
// worth treating as an extraction source. Below this it's almost certainly
// noise (a logo, a blank scan) rather than a flyer with event details.
const MIN_OCR_CHARS = 20;

/**
 * Classify an error thrown by the AI extract step into the small bucket
 * persisted to inbound_emails.extract_fail_reason (drizzle/0094, K7.4).
 *
 * Why a fixed taxonomy: `error` already carries the full message text,
 * which is good for triage but terrible for GROUP BY on the source-
 * quality dashboard. This collapses the variability into 5 buckets that
 * lend themselves to "what's broken this week" queries.
 *
 * Bucket meanings:
 *   - 'zero-events'  : AI returned success with an empty events[]
 *   - 'thin-content' : content sent to AI was <500 chars after strip
 *   - 'parse-error'  : AI response wasn't parseable JSON
 *   - 'ai-timeout'   : Workers AI didn't respond within budget
 *   - 'other'        : anything else; check `error` column for detail
 *
 * Pattern-matches on the NonRetryableError messages produced by
 * submitExtract (`extract-upstream: zero-events`, `extract-network:`,
 * `extract-<status>`).
 */
function classifyExtractFailure(e: unknown): string {
  if (!(e instanceof Error) || typeof e.message !== "string") return "other";
  const msg = e.message;
  if (msg.startsWith("extract-upstream: zero-events")) return "zero-events";
  if (msg.startsWith("extract-upstream: thin-content")) return "thin-content";
  // Workers AI load timeouts surface as 'extract-network: timeout' or as
  // a step-level timeout that doesn't reach our catch. The network
  // bucket covers the former.
  if (msg.startsWith("extract-network:") && /timeout|timed.?out/i.test(msg)) return "ai-timeout";
  if (msg.startsWith("extract-upstream: ") && /parse|json/i.test(msg)) return "parse-error";
  return "other";
}

/** Dispatch table for non-submit, non-new_event intents. The submit
 *  pipeline (and its classifier alias `new_event`) is orchestrated
 *  directly in run() because its three external calls each need to
 *  be a separate checkpointed step.
 *
 *  Classifier-only intents (source_suggestion, claim_request,
 *  vendor_inquiry, spam, unclear, multi) are NOT in this table —
 *  toWorkflowIntent() in email-intents.ts collapses them to the
 *  legacy 6-value union the existing handlers know how to handle.
 *  source_suggestion and spam DO get their own dedicated handlers
 *  because their semantics differ enough from correction/unknown
 *  that mapping would lose information. */
const HANDLERS: Record<Exclude<EmailIntent, "submit" | "new_event">, HandlerFn> = {
  correction: handleCorrection,
  support: handleSupport,
  press: handlePress,
  unsubscribe: handleUnsubscribe,
  unknown: handleUnknown,
  // Classifier-introduced intents with dedicated handlers:
  source_suggestion: handleSourceSuggestion,
  spam: handleSpam,
  // Classifier-introduced intents that route through legacy handlers:
  claim_request: handleCorrection, // record in admin_actions; admin reviews
  vendor_inquiry: handleSupport, // manual response via support template
  unclear: handleUnknown, // catch-all admin triage
  multi: handleUnknown, // parent row of a multi-intent split; children carry the real intent
  // UR1 Phase 1 (2026-06-04) — report@ / feedback@ → problem_reports table
  problem_report: handleProblemReport,
};

/** Map an error message thrown by a submit-leg or handler to a user-
 *  visible reply kind. Submit-specific kinds for submit-intent errors,
 *  null for everything else (admin already saw the forwarded message).
 *  `new_event` is the classifier's alias for `submit` and gets the same
 *  treatment. */
function errorToReplyKind(intent: EmailIntent, errMsg: string): ReplyKind | null {
  if (intent === "submit" || intent === "new_event") {
    if (errMsg.startsWith("submit-")) return "submit-failed";
    return "extract-failed";
  }
  return null;
}

/** Map an admin decision to a tailored reply kind. Decision shape is
 *  sent from the admin UI via `instance.sendEvent({type:"admin-decision",
 *  payload})`. Null decision = waitForEvent timed out; fall back to the
 *  generic ack so the sender doesn't go forever without acknowledgement.
 *  claim_request rides on the correction reply set — same outcomes
 *  (applied/rejected/needs-more-info) and same downstream UX. */
function decisionToReplyKind(intent: EmailIntent, decision: AdminDecision | null): ReplyKind {
  const correctionLike = intent === "correction" || intent === "claim_request";
  if (decision === null) {
    return correctionLike ? "correction-ack" : "press-ack";
  }
  if (correctionLike) {
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
    // Cosmetic status update + workflow_instance_id back-link. The
    // submitter getting an auto-reply matters more than the admin UI
    // showing 'processing' vs 'received', so this step is fail-soft:
    // its UPDATE is wrapped in try/catch and logs a warning instead of
    // throwing. Without this guard a transient D1 hiccup on this
    // non-essential write kills the whole workflow and the submitter
    // gets no response — the actual incident on 2026-05-19 (workflow
    // da76901e-4fb7-4752-b0be-2bc76ae97893, inbound row c6992b79)
    // that drove this change. Bumped retries 1 → 3 with exponential
    // backoff and timeout 5s → 10s for additional resilience under
    // longer D1 hiccups before falling through to soft-failure.
    await step.do(
      "mark-processing",
      {
        retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
        timeout: "10 seconds",
      },
      async () => {
        try {
          const db = getDb(this.env.DB);
          await db
            .update(inboundEmails)
            .set({ status: "processing", workflowInstanceId: sessionId })
            .where(eq(inboundEmails.id, messageRowId));
        } catch (err) {
          await logError(this.env.DB, {
            level: "warn",
            source: SOURCE,
            message: "mark-processing UPDATE failed; continuing workflow",
            sessionId,
            context: {
              messageRowId,
              error: err instanceof Error ? err.message : String(err),
            },
          }).catch(() => {});
        }
      }
    );

    // ───── Step 2: dispatch (per-intent) ────────────────────────────
    let result: HandlerResult;
    let caughtError: string | null = null;

    // OPE-174 — record which pipeline the classified row was dispatched to.
    // Previously `routed_to_workflow` was NEVER written (0/126 rows in prod), so
    // its NULL couldn't be read as "routing didn't happen." Derive it up front
    // from the resolved intent so mark-done can persist it on every path
    // (including a caught dispatch error, where the intended route is still known).
    const routedToWorkflow =
      intent === "submit" || intent === "new_event" ? "submit-pipeline" : `handler:${intent}`;

    try {
      if (intent === "submit" || intent === "new_event") {
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
            // intent is narrowed away from submit | new_event here, so
            // HANDLERS key lookup is safe.
            return await HANDLERS[intent as Exclude<EmailIntent, "submit" | "new_event">](
              this.env,
              { sessionId },
              rows[0]
            );
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
    // The waitForEvent admin-decision pause runs for intents that need
    // human review before the sender's final auto-reply. `claim_request`
    // (classifier-introduced) joins correction + press in this set
    // because it also benefits from admin tailoring (decisionToReplyKind
    // collapses it onto correction's decision shape).
    const needsAdminDecision =
      intent === "correction" || intent === "press" || intent === "claim_request";
    if (!caughtError && needsAdminDecision) {
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
    // Wrapped in try/catch so a send-reply failure (exhausted retries)
    // doesn't error the whole workflow before mark-done can record
    // status='failed'. Without this wrapper the workflow exits at the
    // throw and the row sits in status='processing' forever, outside
    // the stale-row sweep's selection criteria. Root-caused 2026-05-20
    // (the "Boxboro" stuck row): CF Email Sending rejected the custom
    // Message-ID header from commit 0121d6d, send-reply exhausted its
    // 3 retries, workflow errored without reaching mark-done. The
    // Message-ID is now CF-auto-generated (see below) but the wrapper
    // stays as defense-in-depth for any future env.EMAIL.send rejection.
    if (result.replyKind !== null) {
      const replyKind = result.replyKind;
      const replyParams = result.replyParams ?? {};
      try {
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
                messageId: inboundEmails.messageId,
              })
              .from(inboundEmails)
              .where(eq(inboundEmails.id, messageRowId))
              .limit(1);
            if (rows.length === 0) {
              throw new NonRetryableError(
                `inbound_emails row not found for reply: ${messageRowId}`
              );
            }
            // Use replyParams.subject if the handler provided one (e.g.,
            // submit pipeline's success path); otherwise fall back to the
            // row's subject (covers the dispatch-failed synthetic-result
            // path, where the handler threw before populating params).
            const paramsWithSubject =
              "subject" in replyParams
                ? replyParams
                : { ...replyParams, subject: rows[0].subject ?? "" };

            // Phase D.3: issue a receipt-moment feedback token for reply
            // kinds where "was this what you wanted?" makes sense. Skip
            // tailored kinds (correction-applied / press-handled / etc.)
            // — those are admin-driven and already have their own UX.
            // Best-effort: any failure leaves the widget out of the email
            // rather than blocking the reply.
            const RECEIPT_WIDGET_KINDS: ReplyKind[] = [
              "ok",
              // PR-E B3 confidence-aware variants of ok — both deserve the
              // widget the same way "ok" does. Missing from the original
              // PR-E patch (caught in prod 2026-05-21 16:18 UTC when an
              // ok-medium reply went out without voting links).
              "ok-medium",
              "ok-low",
              // Cohort 2 (2026-06-01) — MEDIUM-confidence dedup reply.
              // Sender benefits from the widget the same way ok-medium
              // does (was-this-what-you-wanted feedback). Per
              // [[feedback_receipt_widget_allowlist_when_adding_reply_kinds]].
              "ok-medium-dup",
              // PR-M B1 multi-URL — one widget for the batch (per-event
              // widgets are a follow-up needing schema for per-URL child
              // rows).
              "ok-multi",
              "no-url",
              // GH #244 — distinct from "no-url" because the user did
              // include prose; both still benefit from the "was this what
              // you wanted?" feedback widget. Per memory feedback note on
              // RECEIPT_WIDGET_KINDS missing from PR-E.
              "no-url-prose-failed",
              "already-exists",
              "extract-failed",
              "submit-failed",
            ];
            let params = paramsWithSubject;
            if (RECEIPT_WIDGET_KINDS.includes(replyKind)) {
              try {
                const token = await issueToken(db, {
                  inboundEmailId: messageRowId,
                  feedbackMoment: "receipt",
                  resultingEventId: result.resultingEventId ?? null,
                });
                const base = `https://meetmeatthefair.com/feedback/${encodeURIComponent(token)}`;
                params = {
                  ...paramsWithSubject,
                  feedbackCorrectUrl: `${base}?v=correct`,
                  feedbackWrongIntentUrl: `${base}?v=wrong_intent`,
                  feedbackCancelUrl: `${base}?v=cancel`,
                };
              } catch (err) {
                await logError(this.env.DB, {
                  level: "warn",
                  source: SOURCE,
                  message: "failed to issue receipt feedback token; widget omitted",
                  error: err,
                  sessionId,
                  context: { messageRowId, replyKind },
                });
              }
            }

            // B4 (PR-N): for confidence-uncertain replies that resolved
            // to a real PENDING event, issue a correction token and embed
            // its form URL in the reply. Better UX than asking the
            // sender to write corrections in prose. Only ok-medium and
            // ok-low get this — ok (HIGH) doesn't need it, the negative-
            // outcome kinds (no-url / extract-failed / submit-failed)
            // don't have an event to correct.
            const NEEDS_CORRECTION_FORM: ReplyKind[] = ["ok-medium", "ok-low"];
            if (NEEDS_CORRECTION_FORM.includes(replyKind) && result.resultingEventId) {
              try {
                const correctionToken = await issueCorrectionToken(db, {
                  eventId: result.resultingEventId,
                  inboundEmailId: messageRowId,
                });
                params = {
                  ...params,
                  correctionFormUrl: `https://meetmeatthefair.com/submit-event/${encodeURIComponent(correctionToken)}`,
                };
              } catch (err) {
                // Best-effort: failing to issue the token shouldn't block
                // the reply. Sender just won't see the form link in the
                // email; they can still reply with corrections.
                await logError(this.env.DB, {
                  level: "warn",
                  source: SOURCE,
                  message: "failed to issue correction token; form link omitted",
                  error: err,
                  sessionId,
                  context: { messageRowId, replyKind },
                });
              }
            }

            const msg = buildReply(replyKind, rows[0].fromAddress, params);

            // RFC 5322 threading headers so Gmail / Apple Mail / etc. nest
            // the reply under the user's original message. CF Email Sending
            // auto-generates Message-ID and REJECTS any custom value for it
            // (error: "custom header 'Message-ID' is not allowed"). Only
            // In-Reply-To and References are accepted from the threading
            // triplet — those are enough for Gmail's threading heuristic.
            // Root-caused 2026-05-20 from a stuck Boxboro row; the previous
            // implementation (commit 0121d6d) set Message-ID and killed
            // every auto-reply. See feedback_cf_email_send_header_allowlist
            // memory.
            const headers: Record<string, string> = {};
            if (rows[0].messageId) {
              headers["In-Reply-To"] = rows[0].messageId;
              headers["References"] = rows[0].messageId;
            }

            const sendRes = await this.env.EMAIL.send({
              from: msg.from ?? DEFAULT_FROM,
              to: msg.to,
              subject: msg.subject,
              html: msg.html,
              text: msg.text,
              headers,
            });
            // OPE-151 — ledger the auto-reply. This path sends via env.EMAIL
            // DIRECTLY (bypassing the queue consumer), so it was previously
            // unrecorded — the exact gap that made Carol's reply un-auditable.
            await ledgerEmailSend(db, {
              messageId: `reply-${messageRowId}`,
              recipient: msg.to,
              source: `reply:${replyKind}`,
              subject: msg.subject,
              status: "sent",
              provider: "cf-email",
              providerMessageId: sendRes?.messageId ?? null,
              inboundEmailId: messageRowId,
              bodyHtml: msg.html,
              bodyText: msg.text,
            });
          }
        );
      } catch (err) {
        // send-reply exhausted retries (or threw NonRetryableError).
        // Log + continue to mark-done so the row records the failure
        // instead of staying stuck in status='processing'. The sender
        // doesn't get the auto-reply, but admin sees the failure in
        // /admin/inbound-emails and can decide what to do.
        const sendReplyErr = err instanceof Error ? err.message : String(err);
        await logError(this.env.DB, {
          source: SOURCE,
          message: "send-reply step failed after retries; continuing to mark-done",
          error: err,
          sessionId,
          context: { messageRowId, intent, replyKind, sendReplyError: sendReplyErr },
        });
        // OPE-151 — ledger the failed auto-reply so a silent drop is visible.
        await ledgerEmailSend(getDb(this.env.DB), {
          messageId: `reply-${messageRowId}`,
          recipient: null,
          source: `reply:${replyKind}`,
          status: "failed",
          provider: "cf-email",
          error: sendReplyErr,
          inboundEmailId: messageRowId,
        });
        // Promote to caughtError so mark-done writes status='failed'
        // (rather than 'replied') and the error is visible in the
        // /admin/inbound-emails UI.
        caughtError = caughtError ?? `send-reply: ${sendReplyErr}`;
      }
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
    // PDF detection at the fetch route emits `fetch-pdf: <message>`
    // (analyst C2 Phase 1, 2026-05-29). Surface as its own fetch_method
    // value so /admin/source-quality + analyst's planned A5/F1 dashboard
    // can count PDF-rejected submissions separately from generic
    // both-paths-failed cohort. Phase 2 will replace this with actual
    // PDF text extraction.
    let inferredFetchMethod: "standard" | "browser-rendering" | "failed" | "pdf_unsupported" | null;
    if (caughtError && caughtError.startsWith("fetch-pdf:")) {
      inferredFetchMethod = "pdf_unsupported";
    } else if (caughtError && caughtError.startsWith("fetch-")) {
      inferredFetchMethod = "failed";
    } else {
      inferredFetchMethod = result.fetchMethod ?? null;
    }
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
            // extraction_method tracking (drizzle/0083). Only populated on
            // submit-intent successful extracts (json-ld / ai / thin). On
            // failure paths or non-submit intents the field stays null —
            // matches pre-PR-B rows and keeps "did extraction even run?"
            // queryable.
            extractionMethod: result.extractionMethod ?? null,
            // OPE-174 — record which pipeline handled this row (was never
            // written before). Always set; queryable as "did routing happen?".
            routedToWorkflow,
            // OPE-174 — persist the no-URL / prose-failed salvage reason when the
            // handler set one. CONDITIONAL spread (not `?? null`) so we never
            // overwrite the extract-failed path's own direct write at
            // submit/persist-extract-fail-reason, which runs before mark-done.
            ...(result.extractFailReason ? { extractFailReason: result.extractFailReason } : {}),
            // K7 Tier 1 (analyst, 2026-05-31): thin extractions (AI silent
            // but deterministic salvage produced a partial event) flip
            // flagged_for_review so /admin/inbound-emails surfaces them as
            // a review queue. We only SET the flag here — never clear it —
            // so an operator-set flag on a non-thin row survives.
            ...(result.extractionMethod === "thin" ? { flaggedForReview: 1 } : {}),
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
            // OPE-68: JSON array of stored poster/PDF attachment refs (or
            // null). Read here so the ocr-attachments step can fetch bytes +
            // OCR them into extra submit sources.
            attachmentRefs: inboundEmails.attachmentRefs,
            // B2: read the classifier sub-intent + body excerpt so we can
            // branch into the free-text extraction path when the sender
            // sent prose without a URL.
            classifiedSubIntent: inboundEmails.classifiedSubIntent,
            bodyTextExcerpt: inboundEmails.bodyTextExcerpt,
            // OPE-174 #2 — full body (≤50k) for free-text extraction. The excerpt
            // is only a 500-char preview; a forwarded submission's real event
            // details often fall outside it, so free-text extract must see the
            // whole body (forwarded-header-stripped inside submitFreeTextExtract).
            bodyText: inboundEmails.bodyText,
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

    // OPE-176 — roster capture (STAGE FOR REVIEW; John's call 2026-07-13). Detect
    // an exhibitor/vendor roster in the body and flag the email for operator
    // review instead of dropping it. Runs for EVERY submit email BEFORE the
    // branch returns, so it also catches roster-carrying emails whose event
    // extraction fails (the Art-in-the-Park evidence was no-url-prose-failed).
    // Stage-for-review: we do NOT create or link any vendor — an operator applies
    // the roster by hand from /admin/inbound-emails. Failsoft; never blocks the
    // pipeline. Reads full body_text (bodyTextExcerpt is capped at 500 chars).
    await step.do(
      "submit/roster-capture",
      { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "5 seconds" },
      async () => {
        try {
          const db = getDb(this.env.DB);
          const [row] = await db
            .select({ bodyText: inboundEmails.bodyText })
            .from(inboundEmails)
            .where(eq(inboundEmails.id, messageRowId))
            .limit(1);
          const roster = detectRosterNames(row?.bodyText ?? null);
          if (roster.length === 0) return;
          await db.insert(adminActions).values({
            action: "roster.detected",
            actorUserId: null,
            targetType: "inbound_email",
            targetId: messageRowId,
            payloadJson: JSON.stringify({
              count: roster.length,
              names: roster,
              fromAddress: rowSnapshot.fromAddress,
            }),
            createdAt: new Date(),
          });
          await db
            .update(inboundEmails)
            .set({ flaggedForReview: 1 })
            .where(eq(inboundEmails.id, messageRowId));
        } catch (err) {
          await logError(getDb(this.env.DB), {
            source: "mcp:workflow:roster-capture",
            message: "roster capture failed",
            error: err,
          });
        }
      }
    );

    // ───── OPE-55 Phase 1: unified multi-source fan-out ─────────────
    // Historically the three branches below were MUTUALLY EXCLUSIVE:
    // a URL present dropped the body text; multi_url dropped free-text;
    // no-URL dropped any link. So an email carrying the same/related
    // events across a URL AND its body only ever surfaced one branch's
    // events. Generalize: extract every event-shaped signal from the
    // body prose AND every body-linked URL, dedup across them, and create
    // all surviving unique events.
    //
    // Sources = every URL from extractAllUrls (ordered first) + an
    // optional body-text pseudo-source (ordered LAST). URL-first ordering
    // is deliberate: the richer, provenance-carrying URL event is created
    // first so an identical body-prose candidate collapses against it via
    // the DB-backed dedup round-trip (cross-source dedup for free) — and
    // the surviving row keeps its sourceUrl rather than the body's url:"".
    //
    // We engage the unified path ONLY when there are >= 2 sources (body
    // WITH >= 1 URL) AND the classifier did NOT flag free_text. The
    // free_text override (GH #244) is preserved: when the classifier said
    // "prose only," trust it over a stray signature href and let the
    // body-only B2 path below run. Pure single-source cases (exactly one
    // URL, or body only) fall through to the EXISTING fast paths so their
    // behavior/replies/tests are byte-for-byte unchanged.
    const bodyTextRaw = rowSnapshot.bodyTextExcerpt ?? "";
    const isFreeTextIntent = rowSnapshot.classifiedSubIntent === "free_text";
    const bodyHasSubstance = stripSignature(bodyTextRaw).trim().length > 20;
    const bodyUrls = extractAllUrls(bodyTextRaw, "", 10);

    // ───── OPE-68: OCR poster/PDF attachments into extra submit sources ─────
    // When the receive-time capture stored image/PDF attachments (attachmentRefs
    // present), OCR each via env.AI.toMarkdown and turn any non-trivial markdown
    // into an `attachment` source. When there's at least one such source we route
    // EVERYTHING (body prose + body URLs + attachments) through the unified
    // multi-source fan-out so the poster's event dedups against any body/URL
    // event and all uniques get created. GRACEFUL: the OCR step never throws (it
    // returns [] on any failure), so an OCR/R2/AI miss falls straight through to
    // the pre-OPE-68 branches below. Only runs when attachments were actually
    // stored, so existing no-attachment flows are byte-for-byte unchanged.
    let attachmentSources: SubmitSource[] = [];
    if (rowSnapshot.attachmentCount > 0 && rowSnapshot.attachmentRefs) {
      const refsJson = rowSnapshot.attachmentRefs;
      attachmentSources = await step.do(
        "ocr-attachments",
        { retries: { limit: 1, delay: "10 seconds", backoff: "constant" }, timeout: "60 seconds" },
        () => this.ocrAttachments(refsJson)
      );
    }
    if (attachmentSources.length > 0) {
      const sources: SubmitSource[] = [];
      // Body-linked URLs first (URL-first ordering — richer provenance wins the
      // dedup collapse), unless the classifier said "prose only".
      if (!isFreeTextIntent) {
        sources.push(...bodyUrls.map((url): SubmitSource => ({ kind: "url", url })));
      }
      // Then the body prose pseudo-source when it carries substance.
      if (bodyHasSubstance) sources.push({ kind: "body", text: bodyTextRaw });
      // Then the OCR'd attachments (ordered last, same as the body pseudo-source
      // rationale — provenance-carrying URL/body events created first).
      sources.push(...attachmentSources);
      const overflowed = bodyUrls.length >= 10;
      return await this.runMultiSourcePipeline(
        step,
        sources,
        subject,
        rowSnapshot.fromAddress,
        true, // hasAttachments — attachments were present + OCR'd
        overflowed,
        bodyTextRaw,
        messageRowId
      );
    }

    if (!isFreeTextIntent && bodyHasSubstance && bodyUrls.length >= 1) {
      const sources: SubmitSource[] = [
        ...bodyUrls.map((url): SubmitSource => ({ kind: "url", url })),
        { kind: "body", text: bodyTextRaw },
      ];
      const overflowed = bodyUrls.length >= 10;
      return await this.runMultiSourcePipeline(
        step,
        sources,
        subject,
        rowSnapshot.fromAddress,
        rowSnapshot.attachmentCount > 0,
        overflowed,
        bodyTextRaw,
        messageRowId
      );
    }

    // B1 multi-URL branch — classifier flagged the email as containing
    // multiple distinct event URLs. Fan out sequentially: each URL runs
    // through fetch+extract+dedup+submit independently, results combine
    // into a single 'ok-multi' reply at the end. Falls back to normal
    // single-URL path if multi-URL extraction yields zero or one URL
    // (e.g. classifier mislabeled or all candidates failed cleanUrl).
    if (rowSnapshot.classifiedSubIntent === "multi_url" && rowSnapshot.bodyTextExcerpt) {
      const allUrls = extractAllUrls(rowSnapshot.bodyTextExcerpt, "", 10);
      if (allUrls.length >= 2) {
        const overflowed = allUrls.length >= 10;
        return await this.runMultiUrlPipeline(
          step,
          allUrls,
          subject,
          rowSnapshot.fromAddress,
          rowSnapshot.attachmentCount > 0,
          overflowed,
          rowSnapshot.bodyTextExcerpt ?? ""
        );
      }
    }

    // B2 free-text branch — fires when there's no real event URL but the
    // classifier identified the body as a usable prose event description.
    //
    // Classifier override (GH #244, 2026-05-26): treat as no-URL even when
    // pickPrimaryUrl found a URL, IF the classifier flagged the email as
    // free_text. pickPrimaryUrl can latch onto signature/footer hrefs in
    // HTML bodies — when classifier said "no event URL here," trust it
    // over the regex. The analyst's case: full event prose in body, a
    // signature link in the HTML → workflow used to route through the
    // URL-fetch path and reply with the "couldn't extract from the page
    // you linked" template even though the user pasted full details.
    const isFreeText = rowSnapshot.classifiedSubIntent === "free_text";
    const hasBodyText = (rowSnapshot.bodyTextExcerpt ?? "").trim().length > 20;
    const noUrlOrFreeText = !rowSnapshot.parsedUrl || isFreeText;
    if (noUrlOrFreeText) {
      // Track whether we actually attempted prose extraction so the
      // fallback reply distinguishes "tried, didn't extract enough" from
      // "nothing to try." Drives `no-url-prose-failed` vs `no-url` below.
      let attemptedProse = false;
      if (isFreeText && hasBodyText) {
        attemptedProse = true;
        // Best-effort: if extraction fails to produce a viable event, we
        // fall back to the prose-failed reply rather than send a confusing
        // partial result. The minimum-fields gate inside the workflow
        // (name + (startDate OR venueName)) catches near-empty outputs.
        try {
          const extracted = await step.do(
            "submit/free-text-extract",
            {
              retries: { limit: 1, delay: "10 seconds", backoff: "constant" },
              timeout: "30 seconds",
            },
            // OPE-174 #2 — full body (not the 500-char excerpt) so a forwarded
            // submission's event details below the fold are extractable.
            () =>
              submitFreeTextExtract(
                this.env,
                rowSnapshot.bodyText ?? rowSnapshot.bodyTextExcerpt ?? ""
              )
          );
          const hasMinFields =
            !!extracted.event.name && (!!extracted.event.startDate || !!extracted.event.venueName);
          if (hasMinFields) {
            return await this.submitExtractedEvent(
              step,
              extracted,
              subject,
              rowSnapshot.fromAddress,
              rowSnapshot.attachmentCount > 0,
              null, // no fetch happened on free-text path
              messageRowId,
              true // OPE-185 — drafted from body prose → ok-low-body-extract reply
            );
          }
        } catch {
          // Workers AI extract failed on prose — fall through to the
          // prose-failed reply (closes GH #244's wrong-template path).
          // The inbound_emails row still exists for admin triage via
          // /admin/inbound-emails.
        }
      }
      const replyKind: ReplyKind = attemptedProse ? "no-url-prose-failed" : "no-url";
      return {
        replyKind,
        replyParams: { subject, hasAttachments: rowSnapshot.attachmentCount > 0 },
        status: "replied",
        // OPE-174 — record why we bounced so URL-less submissions are visible in
        // source-quality telemetry (was NULL on this branch before).
        extractFailReason: attemptedProse ? "prose-extract-failed" : "no-fetchable-url",
      };
    }

    // Control-flow guarantee: the noUrlOrFreeText if-block above returns
    // when parsedUrl is null. TS doesn't narrow through the derived
    // boolean, so assert here. Closes a typecheck regression from PR #253
    // (the classifier-override change made the narrowing less direct).
    const url = rowSnapshot.parsedUrl as string;

    let fetched: SubmitFetchResult;
    try {
      fetched = await step.do(
        "submit/fetch-url",
        // 30s timeout (was 20s before A5) — Browser Rendering's managed
        // headless Chrome can take 5–15s on first-cold-Chrome on top of the
        // standard fetch's own 15s budget. drizzle/0078 tracks which path won.
        {
          retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
          timeout: "30 seconds",
        },
        () => submitFetch(this.env, url)
      );
    } catch (fetchErr) {
      // OPE-185 — the URL couldn't be fetched (e.g. share.google / short-links
      // return HTTP 429 to server-side fetchers). If the body carries substantive
      // prose, DRAFT the event from it (PENDING, ok-low-body-extract reply) instead
      // of bouncing. Falls through to the original bounce when there's no usable
      // prose. Failsoft: any hiccup in the fallback re-throws the original error.
      const rawBody = rowSnapshot.bodyText ?? rowSnapshot.bodyTextExcerpt ?? "";
      const proseLen = stripSignature(stripForwardedPreamble(rawBody)).trim().length;
      if (proseLen > 40) {
        try {
          const extracted = await step.do(
            "submit/fetch-fail-body-extract",
            {
              retries: { limit: 1, delay: "10 seconds", backoff: "constant" },
              timeout: "30 seconds",
            },
            () => submitFreeTextExtract(this.env, rawBody)
          );
          const hasMinFields =
            !!extracted.event.name && (!!extracted.event.startDate || !!extracted.event.venueName);
          if (hasMinFields) {
            return await this.submitExtractedEvent(
              step,
              extracted,
              subject,
              rowSnapshot.fromAddress,
              rowSnapshot.attachmentCount > 0,
              null, // no successful fetch — this is a body-prose draft
              messageRowId,
              true // OPE-185 — drafted from body prose → ok-low-body-extract reply
            );
          }
          // Prose present but not enough to draft — record the reason, then bounce.
          await this.recordExtractFailReason(messageRowId, "prose-insufficient");
        } catch {
          // Body extract itself failed — fall through to the original fetch bounce.
        }
      }
      throw fetchErr;
    }

    // K7.4 (analyst, 2026-05-31): persist what we're about to send to the
    // AI extractor BEFORE the AI call, so we can tell what the AI saw
    // even when extraction fails. drizzle/0094 added the three columns —
    // content_length_chars + content_sha256_first16 cluster identical
    // pages on /admin/source-quality so the operator can see "this URL's
    // extracted content has failed 12 times with the same hash."
    // Wrapped in try/catch INSIDE the step body so a transient D1 hiccup
    // on the audit write doesn't fail the whole pipeline — telemetry is
    // not load-bearing. Per [[feedback_workflow_cosmetic_steps_failsoft]].
    await step.do(
      "submit/persist-extract-context",
      { retries: { limit: 1, delay: "2 seconds", backoff: "constant" }, timeout: "5 seconds" },
      async () => {
        try {
          const enc = new TextEncoder().encode(fetched.content);
          const hashBuf = await crypto.subtle.digest("SHA-256", enc);
          const hashHex = Array.from(new Uint8Array(hashBuf))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")
            .slice(0, 16);
          const db = getDb(this.env.DB);
          await db
            .update(inboundEmails)
            .set({
              contentLengthChars: fetched.content.length,
              contentSha256First16: hashHex,
            })
            .where(eq(inboundEmails.id, messageRowId));
        } catch (err) {
          await logError(getDb(this.env.DB), {
            source: "mcp:workflow:persist-extract-context",
            message: "extract-context persist failed",
            error: err,
          });
        }
      }
    );

    // K1 (analyst, 2026-05-29 PM): when AI extraction on the fetched URL
    // returns zero events, fall back to extracting from the email body
    // itself rather than replying extract-failed. Catches the case where
    // the parsedUrl was a tracking redirect or registration page that
    // slipped the host denylist (url-denylist.ts). The fallback is
    // step-scoped so its retry budget is independent of the failed URL-
    // extract step; the existing mark-done logic records
    // extraction_method='free-text' on the inbound_emails row, which
    // distinguishes the fallback path from a clean URL extract for the
    // /admin/source-quality dashboard.
    //
    // D1 (analyst, 2026-05-29 PM): the primary path passes bodyTextExcerpt
    // through to submitExtract so the AI can prefer body dates over the
    // linked page's (e.g. jotform vendor-application's season-start
    // template date). bodyTextExcerpt can be null on some intent paths
    // — coerce to empty string for older-deploy-compat.
    let extracted;
    try {
      extracted = await step.do(
        "submit/ai-extract",
        // limit:1 — audit doc found Workers AI load-timeouts don't recover
        // on tight retries; submitExtract throws NonRetryableError anyway.
        { retries: { limit: 1, delay: "10 seconds", backoff: "constant" }, timeout: "30 seconds" },
        () => submitExtract(this.env, fetched, rowSnapshot.bodyTextExcerpt ?? "")
      );
    } catch (e) {
      // K7.4 (analyst, 2026-05-31): classify the failure into a small
      // bucket and persist to inbound_emails.extract_fail_reason so
      // /admin/source-quality can show the failure-mode distribution
      // separately from raw error strings (which are long, varied, and
      // hard to GROUP BY). Best-effort write — if D1 hiccups here we
      // still proceed to body fallback / rethrow.
      const failReason = classifyExtractFailure(e);
      await step.do(
        "submit/persist-extract-fail-reason",
        { retries: { limit: 1, delay: "2 seconds", backoff: "constant" }, timeout: "5 seconds" },
        async () => {
          try {
            const db = getDb(this.env.DB);
            await db
              .update(inboundEmails)
              .set({ extractFailReason: failReason })
              .where(eq(inboundEmails.id, messageRowId));
          } catch (writeErr) {
            await logError(getDb(this.env.DB), {
              source: "mcp:workflow:persist-extract-fail-reason",
              message: "extract-fail-reason persist failed",
              error: writeErr,
            });
          }
        }
      );

      const isZeroEvents =
        e instanceof NonRetryableError &&
        typeof e.message === "string" &&
        e.message.startsWith("extract-upstream: zero-events");
      const bodyText = rowSnapshot.bodyTextExcerpt;
      if (!isZeroEvents || !bodyText || bodyText.trim().length === 0) throw e;
      extracted = await step.do(
        "submit/free-text-fallback",
        { retries: { limit: 1, delay: "10 seconds", backoff: "constant" }, timeout: "30 seconds" },
        () => submitFreeTextExtract(this.env, bodyText)
      );
    }

    return await this.submitExtractedEvent(
      step,
      extracted,
      subject,
      rowSnapshot.fromAddress,
      rowSnapshot.attachmentCount > 0,
      fetched.fetchMethod,
      messageRowId
    );
  }

  /**
   * Shared tail-end of the submit pipeline: dedup-check → submit-event →
   * confidence-tiered reply (B3). Called from both the URL fetch path
   * and the B2 free-text path; the only difference between the two is
   * how `extracted` was produced (fetched HTML+AI vs body-text-only AI).
   *
   * Reply tier (HIGH/MEDIUM/LOW) is derived from min field confidence
   * over the critical event fields (name, startDate, venueName). HIGH
   * gets the polished "your event X is pending review" template; MEDIUM
   * acknowledges the capture but asks the sender to confirm
   * dates/venue; LOW asks for more details outright. All three create
   * the PENDING event — only the reply differs.
   */
  private async submitExtractedEvent(
    step: WorkflowStep,
    extracted: import("../email-handlers/submit.js").SubmitExtractResult,
    subject: string,
    fromAddress: string,
    hasAttachments: boolean,
    fetchMethod: "standard" | "browser-rendering" | null,
    // K12 (2026-06-02). Threaded from runSubmitPipeline so the new
    // submit/seed-discovery step can FK the email_source_suggestions
    // row back to the triggering inbound_emails row for audit trace.
    messageRowId: string,
    // OPE-185 — TRUE only when the event was drafted purely from the email BODY
    // prose (the free-text branch or the fetch-fail fallback). Routes a fresh
    // create to the distinct `ok-low-body-extract` reply. FALSE for URL /
    // attachment / multi-source callers (they keep the HIGH/MEDIUM/LOW tiers and,
    // for posters, the OPE-68 poster-hero flow).
    bodyExtractDraft = false
  ): Promise<HandlerResult> {
    // C1 Phase 2 (analyst, 2026-05-30): multi-event landing pages
    // (e.g. https://downtownfarmington.com/farmers-markets/ listing 3
    // markets). Phase 1 (PR #267) surfaced the count + first-3 names in
    // the reply but only ingested events[0]. This branch fans out to
    // N PENDING events — one per detected entry — using the ok-multi
    // reply template (same shape as B1 multi-URL).
    if (extracted.events.length > 1) {
      return await this.runMultiEventFanOut(
        step,
        extracted,
        subject,
        fromAddress,
        hasAttachments,
        fetchMethod
      );
    }
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

    // K12 (analyst, 2026-06-02). Submission-seeded discovery — enqueue
    // the submitter's organizer domain so the daily-discovery cron
    // picks up the org's OTHER upcoming events. Fires AFTER dedup
    // (regardless of outcome) so even already-existing submissions
    // benefit when the organizer has more on their /events page than
    // we know about. Failsoft inside the step body per
    // [[feedback_workflow_cosmetic_steps_failsoft]] — the helper
    // itself never throws, but the step wrapper provides one retry
    // for transient infrastructure hiccups.
    await step.do(
      "submit/seed-discovery",
      { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "10 seconds" },
      async () => {
        try {
          await seedDiscoveryCandidate(getDb(this.env.DB), {
            sourceUrl: extracted.url,
            fromAddress,
            inboundEmailId: messageRowId,
          });
        } catch (err) {
          // The helper catches its own errors; this layer exists for
          // the truly-unexpected case (e.g. import-resolution failure
          // on a stale deploy). Never propagate — discovery seeding
          // is purely additive.
          await logError(getDb(this.env.DB), {
            source: "mcp:workflow:seed-discovery",
            message: "seedDiscoveryCandidate threw despite internal catch",
            error: err,
          });
        }
      }
    );

    if (dedup.isDuplicate && dedup.existingEventSlug) {
      // Cohort 2 (analyst, 2026-06-01). K2-part-5 behavior wiring. The
      // dedup matchType comes from findDuplicate (src/lib/duplicates/
      // find-duplicate.ts) and is bucketed:
      //   HIGH   — exact_url, venue_date          → already-exists reply (existing)
      //   MEDIUM — city_state_date, similar_name_date → fall through to
      //            submit-event with possible_duplicate_of tagged; reply
      //            ok-medium-dup so the sender knows it's queued for
      //            operator triage. /admin/events PENDING queue surfaces
      //            the candidate inline with a merge button.
      //
      // Falsy matchType (older deploy or unexpected return shape) defaults
      // to MEDIUM via classifyDedupTier's safer-default branch — keeps the
      // pre-fix behavior of NOT silently dropping the submission. Even
      // safer for ambiguous cases.
      const dedupTier = classifyDedupTier(dedup.matchType ?? "");

      if (dedupTier === "high") {
        // HIGH path — existing behavior unchanged. B5 Phase 1 dedup-tier
        // audit (log-only, when incoming source out-ranks existing).
        // Wrapped in its own step.do so a transient D1 hiccup on the
        // audit write doesn't fail the already-exists reply.
        await step.do(
          "submit/dedup-tier-audit",
          { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "5 seconds" },
          async () => {
            try {
              const fromDomain = fromAddress.includes("@")
                ? (fromAddress.split("@")[1]?.toLowerCase() ?? null)
                : null;
              const candidateTier = classifyDomainTier(extracted.url, {
                contactEmailDomain: fromDomain,
              });
              const existingTier = classifyDomainTier(dedup.existingEventSourceUrl ?? null);
              if (
                dedup.existingEventId &&
                isHigherTier(candidateTier, existingTier) &&
                extracted.url
              ) {
                const db = getDb(this.env.DB);
                await db.insert(adminActions).values({
                  action: "dedup.would_enrich",
                  actorUserId: null,
                  targetType: "event",
                  targetId: dedup.existingEventId,
                  payloadJson: JSON.stringify({
                    matchType: dedup.matchType ?? "exact_url",
                    existingSourceUrl: dedup.existingEventSourceUrl ?? null,
                    existingTier,
                    newSourceUrl: extracted.url,
                    newTier: candidateTier,
                    fromAddress,
                  }),
                  createdAt: new Date(),
                });
              }
            } catch (err) {
              // Non-fatal — Phase 1 is observation only. A failed audit
              // write must not block the already-exists reply.
              await logError(getDb(this.env.DB), {
                source: "mcp:workflow:dedup-tier-audit",
                message: "dedup.would_enrich audit write failed",
                error: err,
              });
            }
          }
        );

        // OPE-175 — enrich-on-match, STAGED FOR REVIEW (John's call 2026-07-13:
        // fill-empty only, land PENDING). When a submission dedups to an existing
        // event, capture the fields the email could FILL that are currently EMPTY
        // on that event (image_url, source_url, description) and flag the inbound
        // row for operator review — WITHOUT mutating the live (usually APPROVED)
        // event. The operator applies the fills by hand from /admin/inbound-emails.
        // Fill-empty-only: a populated field is never proposed, so curated data is
        // untouchable. Distinct from the tier-audit's `dedup.would_enrich`
        // observation above (which fires on source-tier promotion, not empty
        // fields). Failsoft — a hiccup here must not block the already-exists reply.
        if (dedup.existingEventId) {
          const existingEventId = dedup.existingEventId;
          await step.do(
            "submit/enrich-proposal",
            {
              retries: { limit: 1, delay: "5 seconds", backoff: "constant" },
              timeout: "5 seconds",
            },
            async () => {
              try {
                const db = getDb(this.env.DB);
                const [existing] = await db
                  .select({
                    imageUrl: events.imageUrl,
                    sourceUrl: events.sourceUrl,
                    description: events.description,
                  })
                  .from(events)
                  .where(eq(events.id, existingEventId))
                  .limit(1);
                if (!existing) return;
                const proposals = computeFillEmptyProposals(existing, {
                  imageUrl: extracted.event.imageUrl,
                  sourceUrl: extracted.url,
                  description: extracted.event.description,
                });
                if (Object.keys(proposals).length === 0) return;

                await db.insert(adminActions).values({
                  action: "dedup.enrich_proposed",
                  actorUserId: null,
                  targetType: "event",
                  targetId: existingEventId,
                  payloadJson: JSON.stringify({
                    proposals,
                    matchType: dedup.matchType ?? "exact_url",
                    source: extracted.url || null,
                    inboundEmailId: messageRowId,
                    fromAddress,
                  }),
                  createdAt: new Date(),
                });
                // Surface the row in the /admin/inbound-emails review queue so an
                // operator sees "matched + has fillable data" rather than a silent
                // already-exists. SET only — never clears an operator's own flag.
                await db
                  .update(inboundEmails)
                  .set({ flaggedForReview: 1 })
                  .where(eq(inboundEmails.id, messageRowId));
              } catch (err) {
                await logError(getDb(this.env.DB), {
                  source: "mcp:workflow:enrich-proposal",
                  message: "dedup enrich-proposal capture failed",
                  error: err,
                });
              }
            }
          );
        }

        return {
          replyKind: "already-exists",
          replyParams: {
            subject,
            eventName: dedup.existingEventName ?? extracted.event.name,
            eventUrl: `https://meetmeatthefair.com/events/${dedup.existingEventSlug}`,
            matchType: dedup.matchType ?? "exact_url",
            existingEventStatus: dedup.existingEventStatus ?? "",
          },
          status: "replied",
          resultingEventId: dedup.existingEventId ?? null,
          fetchMethod,
          extractionMethod: extracted.extractionMethod,
        };
      }

      // MEDIUM path. Fall through to submit-event with the
      // possible_duplicate_of tag set; reply ok-medium-dup so the
      // sender knows we noticed the possible overlap. Operator sees
      // both rows side-by-side on /admin/events and decides.
      //
      // No B5 audit on this path — the audit covers "would have
      // enriched" (HIGH-source-tier promotion of an existing row),
      // which is orthogonal to MEDIUM dedup. If a future enrich-on-
      // MEDIUM lands, it gets its own audit row.
      const submittedMedium = await step.do(
        "submit/submit-event",
        {
          retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
          timeout: "15 seconds",
        },
        () => submitEvent(this.env, extracted, fromAddress, dedup.existingEventId ?? null)
      );

      return {
        replyKind: "ok-medium-dup",
        replyParams: {
          subject,
          eventName: submittedMedium.eventName,
          eventSlug: submittedMedium.slug,
          candidateName: dedup.existingEventName ?? "an existing event",
          candidateUrl: dedup.existingEventSlug
            ? `https://meetmeatthefair.com/events/${dedup.existingEventSlug}`
            : "",
          matchType: dedup.matchType ?? "",
        },
        status: "replied",
        resultingEventId: submittedMedium.id,
        fetchMethod,
        extractionMethod: extracted.extractionMethod,
      };
    }

    const submitted = await step.do(
      "submit/submit-event",
      { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "15 seconds" },
      () => submitEvent(this.env, extracted, fromAddress)
    );

    // B3 confidence-aware reply. Pick HIGH/MEDIUM/LOW based on min
    // confidence across the fields a submitter most needs to verify
    // (name + date + venue). When the extract endpoint didn't return
    // confidence (older deploy / edge cases) default to HIGH — fall
    // back to current behavior rather than over-asking the sender.
    // OPE-185 — an event drafted purely from body prose gets the distinct
    // low-confidence `ok-low-body-extract` reply ("we drafted this from your
    // message; the team will review before publishing") per the OPE-6 STOP-gate,
    // regardless of per-field confidence. URL/attachment/multi-source callers pass
    // bodyExtractDraft=false and keep the existing HIGH/MEDIUM/LOW tiers.
    const confidenceTier = computeReplyTier(extracted.fieldConfidence);
    const replyKind: ReplyKind = bodyExtractDraft
      ? "ok-low-body-extract"
      : confidenceTier === "high"
        ? "ok"
        : confidenceTier === "medium"
          ? "ok-medium"
          : "ok-low";

    return {
      replyKind,
      replyParams: {
        subject,
        eventName: submitted.eventName,
        eventSlug: submitted.slug,
        hasAttachments,
        // Surface which fields the extractor was unsure about so the
        // MEDIUM/LOW templates can name them.
        unsureFields: summarizeUnsureFields(extracted.fieldConfidence),
        // Multi-event landing page (analyst D1 Phase 1, 2026-05-29):
        // when the extractor pulled multiple events off the same
        // page, tell the sender we noticed them and offer the manual
        // path. Phase 2 (separate PR) will fan out into N PENDING
        // events automatically.
        additionalEventsDetected:
          extracted.totalEventsDetected > 1 ? extracted.totalEventsDetected - 1 : 0,
        additionalEventNames: extracted.additionalEventNames,
      },
      status: "replied",
      resultingEventId: submitted.id,
      fetchMethod,
      extractionMethod: extracted.extractionMethod,
    };
  }

  /**
   * C1 Phase 2 multi-event fan-out. Called from submitExtractedEvent when
   * a SINGLE URL (or B2 free-text body) produced >1 events. Distinct from
   * runMultiUrlPipeline — that one handles N URLs from the body, this
   * handles N events extracted from one source. Same outcome-aggregation
   * shape feeding the same ok-multi reply template.
   *
   * Per-event: rebuild a single-event-shaped extracted struct
   * (`{...extracted, event: events[i]}`) and run the standard
   * dedup-then-submit pair as their own step.do checkpoints. Each event
   * gets its own duplicate-check (different name/date → no spurious
   * collisions across events on the same page). Skips the B5 Phase 1
   * dedup-tier audit per-event — same posture as runMultiUrlPipeline,
   * since the multi-event dedup-hit case is rare and the existing log
   * write isn't worth the added per-iteration overhead.
   *
   * resulting_event_id on the parent inbound_emails row is set to the
   * FIRST created event id, mirroring the multi-URL behavior so admin
   * has a useful jump-link. Parent/child inbound_emails lineage (one
   * row per child event) is a separate follow-up — analyst noted as
   * deferred. fetchMethod is forwarded so /admin/source-quality keeps
   * accurate path attribution across the fanned-out events.
   */
  private async runMultiEventFanOut(
    step: WorkflowStep,
    extracted: import("../email-handlers/submit.js").SubmitExtractResult,
    subject: string,
    fromAddress: string,
    hasAttachments: boolean,
    fetchMethod: "standard" | "browser-rendering" | null
  ): Promise<HandlerResult> {
    interface EventOutcome {
      eventName: string;
      kind: "created" | "already-exists" | "submit-failed";
      eventSlug?: string;
      eventId?: string;
    }
    const outcomes: EventOutcome[] = [];
    let firstCreatedEventId: string | null = null;

    for (let i = 0; i < extracted.events.length; i++) {
      const childEvent = extracted.events[i];
      // Build a single-event-shaped struct so the existing submitCheck-
      // Duplicate / submitEvent functions can reuse their current paths.
      // url/fieldConfidence/extractionMethod are shared across all events
      // from one source page so we carry them through verbatim.
      const perEvent: import("../email-handlers/submit.js").SubmitExtractResult = {
        ...extracted,
        event: childEvent,
      };
      const labelPrefix = `submit/fanout[${i}]`;
      try {
        const dedup = await step.do(
          `${labelPrefix}/check-duplicate`,
          { retries: { limit: 2, delay: "5 seconds", backoff: "constant" }, timeout: "10 seconds" },
          () => submitCheckDuplicate(this.env, perEvent)
        );
        if (dedup.isDuplicate && dedup.existingEventSlug) {
          outcomes.push({
            eventName: dedup.existingEventName ?? childEvent.name,
            kind: "already-exists",
            eventSlug: dedup.existingEventSlug,
            eventId: dedup.existingEventId,
          });
          continue;
        }
        const submitted = await step.do(
          `${labelPrefix}/submit-event`,
          {
            retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
            timeout: "15 seconds",
          },
          () => submitEvent(this.env, perEvent, fromAddress)
        );
        outcomes.push({
          eventName: submitted.eventName,
          kind: "created",
          eventSlug: submitted.slug,
          eventId: submitted.id,
        });
        if (!firstCreatedEventId) firstCreatedEventId = submitted.id;
      } catch (err) {
        // Per-event failures degrade gracefully — other events still run.
        // Unlike multi-URL there's no fetch-failed / extract-failed branch
        // here; the extractor already returned all events successfully,
        // so any failure during fan-out is a submit-side issue.
        const msg = err instanceof Error ? err.message : String(err);
        outcomes.push({
          eventName: childEvent.name || `Event ${i + 1}`,
          kind: "submit-failed",
        });
        // Log so /admin/diagnostics surfaces the failure pattern.
        await logError(getDb(this.env.DB), {
          source: "mcp:workflow:multi-event-fanout",
          message: `submit failed for event ${i + 1}/${extracted.events.length}: ${msg}`,
          error: err,
        });
      }
    }

    // Reuse the ok-multi template's bullet shape. Each event becomes one
    // line — no URLs in the rendered text because every event shares the
    // same source URL on a multi-event landing page.
    const resultsText = outcomes
      .map((o) => {
        switch (o.kind) {
          case "created":
            return `✅ "${o.eventName}" — pending review`;
          case "already-exists":
            return `✅ "${o.eventName}" — already in our directory: https://meetmeatthefair.com/events/${o.eventSlug}`;
          case "submit-failed":
            return `❌ Couldn't save "${o.eventName}" — our team will follow up`;
        }
      })
      .join("\n");

    return {
      replyKind: "ok-multi",
      replyParams: {
        subject,
        eventCount: outcomes.length,
        resultsText,
        hasAttachments,
        // Multi-event fan-out doesn't overflow at the URL-extraction layer
        // (those are URLs, not extracted events). Keep the template field
        // satisfied with false.
        overflowed: false,
      },
      status: "replied",
      resultingEventId: firstCreatedEventId,
      fetchMethod,
      extractionMethod: extracted.extractionMethod,
    };
  }

  /**
   * OPE-55 Phase 1 — unified multi-source fan-out. Generalizes
   * runMultiUrlPipeline (N URLs) to a HETEROGENEOUS source list: the
   * email body prose PLUS every body-linked URL. Called from
   * runSubmitPipeline when there are >= 2 sources (body + >= 1 URL) and
   * the classifier didn't flag free_text.
   *
   * Two phases:
   *
   *   Phase A — extraction. Walk the sources SEQUENTIALLY, each leg its
   *   own step.do checkpoint (URL: `submit/multi[i]/fetch-url` +
   *   `.../ai-extract`; body: `submit/bodytext/extract`). A URL's fetch
   *   or extract failure is recorded and surfaced to the sender (a linked
   *   page we couldn't use is worth mentioning). The body pseudo-source
   *   failing (or extracting no event — a polite one-liner accompanying a
   *   link) is SWALLOWED: it simply contributes zero candidates, so the
   *   common "here's my link, thanks!" email still resolves to the single
   *   URL reply below. Body candidates additionally pass the B2 min-field
   *   gate (name + startDate|venueName) so prose noise doesn't create thin
   *   events; URL candidates are trusted as in the existing URL paths. A
   *   source that extracts >1 events contributes one candidate per event.
   *
   *   Phase B — N=1 collapse. When the sources produced exactly ONE
   *   candidate and no URL source failed, route it through the existing
   *   single-event tail (submitExtractedEvent) so the rich reply tiers
   *   (HIGH/MEDIUM/LOW confidence, already-exists, ok-medium-dup,
   *   correction-form widget, seed-discovery) are identical to a plain
   *   single-source submission. This keeps the ubiquitous "one URL + a
   *   sentence of body" shape on the exact reply it gets today.
   *
   *   Phase C — fan out. Process every candidate SEQUENTIALLY through the
   *   dedup-then-submit pair (each its own step.do). Sequential order +
   *   the DB-backed submitCheckDuplicate gives cross-source dedup for
   *   free: once URL₁'s event is created, an identical body candidate
   *   dedups against the now-existing row. Per-item step isolation means a
   *   failing candidate drops only itself. Aggregated into the existing
   *   ok-multi reply. resulting_event_id = first created event id (mirrors
   *   the other fan-outs' admin jump-link behavior).
   */
  /**
   * OPE-68 — OCR stored poster/PDF attachments into `attachment` submit
   * sources. Runs as the body of the best-effort `ocr-attachments` step.
   *
   * Reads the JSON attachment_refs, fetches each object's bytes from the
   * shared vendor-assets R2 bucket, and runs env.AI.toMarkdown (converts
   * images AND PDFs → markdown in one call). Any ref whose markdown is
   * non-trivial (>= MIN_OCR_CHARS after trim) becomes an `attachment` source
   * carrying that text (for extraction) plus the R2 key when the attachment
   * is an image (so a resulting CREATED event can take the poster as its
   * hero).
   *
   * GRACEFUL by contract — never throws. A missing AI/R2 binding, a malformed
   * refs blob, a missing object, or a per-attachment toMarkdown error each
   * skip that attachment (or all) and contribute no source. Worst case: [].
   */
  private async ocrAttachments(refsJson: string): Promise<SubmitSource[]> {
    const bucket = this.env.VENDOR_ASSETS;
    const ai = this.env.AI;
    if (!bucket || !ai) {
      // OPE-189 — this used to be a SILENT [] (0 events, 0 logs). Log the missing
      // binding so an OCR no-op can never again hide as "attachment not usable".
      await logError(getDb(this.env.DB), {
        level: "warn",
        source: "mcp:workflow:ocr-attachments",
        message: `ocr skipped — binding missing (bucket=${!!bucket}, ai=${!!ai})`,
      }).catch(() => {});
      return [];
    }
    let refs: AttachmentRef[];
    try {
      const parsed = JSON.parse(refsJson);
      if (!Array.isArray(parsed)) return [];
      refs = parsed as AttachmentRef[];
    } catch {
      return [];
    }
    const sources: SubmitSource[] = [];
    for (const ref of refs) {
      if (!ref || typeof ref.key !== "string") continue;
      // OPE-189 — record a concrete per-attachment outcome for EVERY path so a
      // 0-source OCR run is diagnosable from error_logs (was invisible: the
      // toMarkdown `format:"error"` variant and the under-threshold drop both fell
      // through to [] with no trace).
      let outcome = "unknown";
      try {
        const obj = await bucket.get(ref.key);
        if (!obj) {
          outcome = "object-not-found";
        } else {
          const blob = await obj.blob();
          const results = await ai.toMarkdown([{ name: ref.name || ref.key, blob }]);
          const first = Array.isArray(results) ? results[0] : results;
          if (first && first.format === "markdown") {
            const text = first.data;
            const len = typeof text === "string" ? text.trim().length : 0;
            if (typeof text === "string" && len >= MIN_OCR_CHARS) {
              const mime = (ref.mimeType || "").toLowerCase();
              sources.push({
                kind: "attachment",
                text,
                name: ref.name || "attachment",
                imageKey: mime.startsWith("image/") ? ref.key : undefined,
              });
              outcome = `ok:${len}chars`;
            } else {
              outcome = `under-threshold:${len}chars(min=${MIN_OCR_CHARS})`;
            }
          } else if (first && first.format === "error") {
            // The conversion itself failed — surface its error (was discarded).
            outcome = `toMarkdown-error:${String((first as { error?: string }).error ?? "").slice(0, 200)}`;
          } else {
            outcome = `unexpected-shape:${first ? JSON.stringify(first).slice(0, 150) : "null"}`;
          }
        }
      } catch (err) {
        outcome = "threw";
        await logError(getDb(this.env.DB), {
          level: "warn",
          source: "mcp:workflow:ocr-attachments",
          message: "toMarkdown/get threw for attachment; skipping",
          error: err,
        }).catch(() => {});
      }
      await logError(getDb(this.env.DB), {
        level: outcome.startsWith("ok:") ? "info" : "warn",
        source: "mcp:workflow:ocr-attachments",
        message: `attachment "${ref.name || ref.key}" (${ref.mimeType || "?"}, ${ref.size ?? "?"}B): ${outcome}`,
      }).catch(() => {});
    }
    return sources;
  }

  /**
   * OPE-68 (poster-as-hero, best-effort) — set a created event's hero image
   * from the stored poster. Fetches the poster bytes from R2 and POSTs them
   * through the main-app upload-image-bytes endpoint (same canonical path
   * upload_image_bytes uses: EXIF strip → resize → WebP → events.image_url →
   * events/{id}/… CDN key).
   *
   * Wrapped best-effort: a hero-image failure (missing binding, upload error,
   * unsupported content type) must NOT fail event creation, so the whole step
   * swallows errors. The acceptance criteria don't require the hero image.
   */
  private async setEventHeroFromPoster(
    step: WorkflowStep,
    label: string,
    eventId: string,
    imageKey: string
  ): Promise<void> {
    try {
      await step.do(
        label,
        { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "20 seconds" },
        async () => {
          const bucket = this.env.VENDOR_ASSETS;
          if (!bucket) return;
          const obj = await bucket.get(imageKey);
          if (!obj) return;
          const bytes = new Uint8Array(await obj.arrayBuffer());
          const contentType = obj.httpMetadata?.contentType || "image/jpeg";
          const form = new FormData();
          form.append("file", new Blob([bytes], { type: contentType }), "poster");
          form.append("target_type", "event");
          form.append("target_id", eventId);
          const res = await fetch(`${this.env.MAIN_APP_URL}/api/admin/upload-image-bytes`, {
            method: "POST",
            headers: { "X-Internal-Key": this.env.INTERNAL_API_KEY },
            body: form,
          });
          if (!res.ok) {
            await logError(getDb(this.env.DB), {
              level: "warn",
              source: "mcp:workflow:poster-hero",
              message: `upload-image-bytes returned ${res.status}; hero image skipped`,
            }).catch(() => {});
          }
        }
      );
    } catch (err) {
      // Never propagate — poster-as-hero is purely additive.
      await logError(getDb(this.env.DB), {
        level: "warn",
        source: "mcp:workflow:poster-hero",
        message: "poster-as-hero step failed; event still created",
        error: err,
      }).catch(() => {});
    }
  }

  /**
   * OPE-69 — best-effort per-source provenance write. Records
   * event_data_citations rows for the given event, attributed to `source`.
   * A citation failure must NEVER fail event creation or the pipeline (the
   * event already exists; provenance is polish), so the whole thing is wrapped
   * step.do + try/catch and swallows errors after logging.
   *
   * OPE-69 follow-up: the per-source citation count is now queryable from
   * event_data_citations — a "N sources agreed" admin surface (OPE-55 Phase 3
   * item 3) is intentionally out of scope for this ticket.
   */
  /**
   * OPE-185/OPE-174 — failsoft direct write of a categorical extract_fail_reason
   * on a path that bounces BEFORE mark-done can carry the reason (mirrors the
   * extract-failed path's own direct write). mark-done's conditional spread only
   * writes extract_fail_reason when the result carries one, so it never clobbers
   * this value.
   */
  private async recordExtractFailReason(messageRowId: string, reason: string): Promise<void> {
    try {
      await getDb(this.env.DB)
        .update(inboundEmails)
        .set({ extractFailReason: reason })
        .where(eq(inboundEmails.id, messageRowId));
    } catch (err) {
      await logError(getDb(this.env.DB), {
        source: "mcp:workflow:record-extract-fail-reason",
        message: "extract_fail_reason direct write failed",
        error: err,
      });
    }
  }

  private async recordCitationsBestEffort(
    step: WorkflowStep,
    label: string,
    eventId: string,
    extracted: import("../email-handlers/submit.js").SubmitExtractResult,
    source: SubmitSource,
    fromAddress: string
  ): Promise<void> {
    try {
      await step.do(
        label,
        { retries: { limit: 2, delay: "5 seconds", backoff: "constant" }, timeout: "10 seconds" },
        async () => {
          const inserted = await recordSourceCitations(getDb(this.env.DB), {
            eventId,
            extracted,
            source,
            fromAddress,
          });
          return { inserted };
        }
      );
    } catch (err) {
      // Never propagate — provenance is additive; the event is already created.
      await logError(getDb(this.env.DB), {
        level: "warn",
        source: "mcp:workflow:pipeline-citations",
        message: "recordSourceCitations failed; event unaffected",
        error: err,
      }).catch(() => {});
    }
  }

  private async runMultiSourcePipeline(
    step: WorkflowStep,
    sources: SubmitSource[],
    subject: string,
    fromAddress: string,
    hasAttachments: boolean,
    overflowed: boolean,
    // Passed to each URL source's submitExtract so the AI's two-section
    // prompt can prefer body dates over the linked page's (analyst D1).
    emailBody: string,
    messageRowId: string
  ): Promise<HandlerResult> {
    interface SourceCandidate {
      // Single-event-shaped (events = [event]); url carries provenance
      // ("" for body-sourced events → submitEvent omits sourceUrl).
      extracted: import("../email-handlers/submit.js").SubmitExtractResult;
      fetchMethod: "standard" | "browser-rendering" | null;
      // OPE-68 — this candidate came from an OCR'd attachment (drives the
      // attachmentEventsCreated reply signal). `imageKey` is set only when the
      // attachment was an image (drives the poster-as-hero best-effort set).
      fromAttachment: boolean;
      imageKey?: string;
      // OPE-69 — the originating source, threaded into Phase C so per-source
      // event_data_citations rows can be attributed (url / body / attachment).
      source: SubmitSource;
    }
    interface SourceFailure {
      url: string;
      kind: "fetch-failed" | "extract-failed";
    }
    const candidates: SourceCandidate[] = [];
    const sourceFailures: SourceFailure[] = [];

    // ── Phase A: extract candidate events from every source. ──────────
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      // Body prose AND OPE-68 OCR'd attachments both extract via the free-text
      // path (submitFreeTextExtract over their text) and share the same
      // minimum-fields gate. The only difference is provenance tagging.
      if (source.kind === "body" || source.kind === "attachment") {
        const isAttachment = source.kind === "attachment";
        const stepLabel = isAttachment
          ? `submit/attachment[${i}]/extract`
          : "submit/bodytext/extract";
        try {
          const extracted = await step.do(
            stepLabel,
            {
              retries: { limit: 1, delay: "10 seconds", backoff: "constant" },
              timeout: "30 seconds",
            },
            () => submitFreeTextExtract(this.env, source.text)
          );
          for (const ev of extracted.events) {
            // Same minimum-fields gate the B2 free-text path applies, so a
            // body/poster that extracts a near-empty event (name only)
            // contributes nothing rather than a thin PENDING row.
            const hasMinFields = !!ev.name && (!!ev.startDate || !!ev.venueName);
            if (!hasMinFields) continue;
            candidates.push({
              extracted: { ...extracted, event: ev, events: [ev] },
              fetchMethod: null,
              fromAttachment: isAttachment,
              imageKey: isAttachment ? source.imageKey : undefined,
              source,
            });
          }
        } catch {
          // No usable event in the prose/poster — expected for accompanying
          // text or an unreadable flyer. Swallowed by design (Phase A docblock).
        }
        continue;
      }
      // URL source: fetch then AI-extract, each its own checkpoint.
      const labelPrefix = `submit/multi[${i}]`;
      let fetched: import("../email-handlers/submit.js").SubmitFetchResult;
      try {
        fetched = await step.do(
          `${labelPrefix}/fetch-url`,
          {
            retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
            timeout: "30 seconds",
          },
          () => submitFetch(this.env, source.url)
        );
      } catch {
        sourceFailures.push({ url: source.url, kind: "fetch-failed" });
        continue;
      }
      try {
        const extracted = await step.do(
          `${labelPrefix}/ai-extract`,
          {
            retries: { limit: 1, delay: "10 seconds", backoff: "constant" },
            timeout: "30 seconds",
          },
          () => submitExtract(this.env, fetched, emailBody)
        );
        for (const ev of extracted.events) {
          candidates.push({
            extracted: { ...extracted, event: ev, events: [ev] },
            fetchMethod: fetched.fetchMethod,
            fromAttachment: false,
            source,
          });
        }
      } catch {
        sourceFailures.push({ url: source.url, kind: "extract-failed" });
      }
    }

    // ── Phase B: N=1 collapse → existing single-event rich reply. ─────
    if (candidates.length === 1 && sourceFailures.length === 0) {
      const only = candidates[0];
      const res = await this.submitExtractedEvent(
        step,
        only.extracted,
        subject,
        fromAddress,
        hasAttachments,
        only.fetchMethod,
        messageRowId
      );
      // OPE-68 — when this lone candidate came from a poster/PDF and a NEW
      // event was created (ok / ok-medium / ok-low), set the poster as its
      // hero (image attachments only) and thread the outcome-aware signal so
      // the reply says "we read your poster" instead of the old "we don't
      // process attachments" copy.
      const created =
        !!res.resultingEventId &&
        (res.replyKind === "ok" || res.replyKind === "ok-medium" || res.replyKind === "ok-low");
      if (only.fromAttachment && created) {
        if (only.imageKey && res.resultingEventId) {
          await this.setEventHeroFromPoster(
            step,
            "submit/poster-hero",
            res.resultingEventId,
            only.imageKey
          );
        }
        return {
          ...res,
          replyParams: {
            ...(res.replyParams ?? {}),
            attachmentsRead: true,
            attachmentEventsCreated: 1,
          },
        };
      }
      return res;
    }

    // ── Phase C: fan out over every candidate, dedup-then-submit. ─────
    interface SourceOutcome {
      kind: "created" | "already-exists" | "submit-failed" | "extract-failed" | "fetch-failed";
      eventName?: string;
      eventSlug?: string;
      url?: string;
    }
    const outcomes: SourceOutcome[] = [];
    let firstCreatedEventId: string | null = null;
    // OPE-68 — how many CREATED events came from an OCR'd attachment. Threaded
    // into the reply so copy can reflect "we read your poster/PDF".
    let attachmentEventsCreated = 0;

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      const { extracted } = cand;
      const sourceUrl = extracted.url; // "" for body-sourced events
      const labelPrefix = `submit/source-event[${i}]`;
      try {
        const dedup = await step.do(
          `${labelPrefix}/check-duplicate`,
          { retries: { limit: 2, delay: "5 seconds", backoff: "constant" }, timeout: "10 seconds" },
          () => submitCheckDuplicate(this.env, extracted)
        );
        if (dedup.isDuplicate && dedup.existingEventSlug) {
          outcomes.push({
            kind: "already-exists",
            eventName: dedup.existingEventName ?? extracted.event.name,
            eventSlug: dedup.existingEventSlug,
            url: sourceUrl || undefined,
          });
          // OPE-69 — the candidate deduped into an existing event: attach THIS
          // source's provenance to the keeper before dropping the candidate, so
          // "another source also cited these fields" is preserved. Best-effort.
          if (dedup.existingEventId) {
            await this.recordCitationsBestEffort(
              step,
              `${labelPrefix}/cite-keeper`,
              dedup.existingEventId,
              extracted,
              cand.source,
              fromAddress
            );
          }
          continue;
        }
        const submitted = await step.do(
          `${labelPrefix}/submit-event`,
          {
            retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
            timeout: "15 seconds",
          },
          () => submitEvent(this.env, extracted, fromAddress)
        );
        outcomes.push({
          kind: "created",
          eventName: submitted.eventName,
          eventSlug: submitted.slug,
          url: sourceUrl || undefined,
        });
        if (!firstCreatedEventId) firstCreatedEventId = submitted.id;
        // OPE-69 — record this source's provenance on the newly-created event.
        // Best-effort: never fails the pipeline (the event already exists).
        await this.recordCitationsBestEffort(
          step,
          `${labelPrefix}/cite`,
          submitted.id,
          extracted,
          cand.source,
          fromAddress
        );
        // OPE-68 — attachment-sourced created event: count it + (image only)
        // set the stored poster as the event hero, best-effort.
        if (cand.fromAttachment) {
          attachmentEventsCreated++;
          if (cand.imageKey) {
            await this.setEventHeroFromPoster(
              step,
              `${labelPrefix}/poster-hero`,
              submitted.id,
              cand.imageKey
            );
          }
        }
      } catch (err) {
        // Per-candidate failure degrades gracefully — the others still run.
        const msg = err instanceof Error ? err.message : String(err);
        outcomes.push({
          kind: msg.startsWith("submit-") ? "submit-failed" : "extract-failed",
          eventName: extracted.event.name || `Event ${i + 1}`,
          url: sourceUrl || undefined,
        });
        await logError(getDb(this.env.DB), {
          source: "mcp:workflow:multi-source-fanout",
          message: `submit failed for source-event ${i + 1}/${candidates.length}: ${msg}`,
          error: err,
        });
      }
    }

    // OPE-68 — nothing extractable from ANY source (e.g. a bare "see attached"
    // body plus a poster that OCR'd to noise). Previously unreachable here (the
    // pre-OPE-68 callers always pass >= 1 URL source, which always yields an
    // outcome), so this guard is inert for them. With attachments in the mix it
    // prevents a nonsensical "Thanks for submitting 0 events" reply — fall back
    // to the soft prose/no-url ask instead.
    if (outcomes.length === 0) {
      return {
        replyKind: hasAttachments ? "no-url-prose-failed" : "no-url",
        replyParams: { subject, hasAttachments },
        status: "replied",
        // OPE-174 — same telemetry gap as the single-source no-URL branch: record
        // the bounce reason. `prose-extract-failed` covers the attachments-OCR'd-
        // to-noise case (the reply_kind already folds attachments into that bucket).
        extractFailReason: hasAttachments ? "prose-extract-failed" : "no-fetchable-url",
      };
    }

    // Fold the URL source-level failures (fetch/extract) in as bullets so
    // the sender sees which linked pages we couldn't use.
    for (const f of sourceFailures) {
      outcomes.push({ kind: f.kind, url: f.url });
    }

    // Reuse the ok-multi template's bullet shape (same glyphs as the other
    // fan-outs — buildReply HTML-escapes them safely).
    const resultsText = outcomes
      .map((o) => {
        switch (o.kind) {
          case "created":
            return `✅ "${o.eventName}" — pending review`;
          case "already-exists":
            return `✅ "${o.eventName}" — already in our directory: https://meetmeatthefair.com/events/${o.eventSlug}`;
          case "extract-failed":
            return o.url
              ? `❌ Couldn't extract event details from ${o.url}`
              : `❌ Couldn't save "${o.eventName}" — our team will follow up`;
          case "fetch-failed":
            return `❌ Couldn't fetch ${o.url}`;
          case "submit-failed":
            return o.url
              ? `❌ Extracted event from ${o.url} but couldn't save it — our team will follow up`
              : `❌ Couldn't save "${o.eventName}" — our team will follow up`;
        }
      })
      .join("\n");

    return {
      replyKind: "ok-multi",
      replyParams: {
        subject,
        eventCount: outcomes.length,
        resultsText,
        hasAttachments,
        overflowed,
        // OPE-68 — outcome-aware attachment signal for the reply builder.
        attachmentsRead: attachmentEventsCreated > 0,
        attachmentEventsCreated,
      },
      status: "replied",
      resultingEventId: firstCreatedEventId,
      // Mixed body + URL sources may have used different fetch paths; leave
      // the parent row's fetch_method null (same posture as runMultiUrl-
      // Pipeline). Per-source paths are visible in the step-output trail.
      fetchMethod: null,
      extractionMethod: "ai",
    };
  }

  /**
   * B1 multi-URL pipeline. Called from runSubmitPipeline when classifier
   * flagged sub_intent='multi_url' AND >=2 URLs were extracted from the
   * body. Runs the standard fetch+extract+dedup+submit cycle SEQUENTIALLY
   * per URL — each leg is its own step.do so a transient failure on one
   * URL doesn't redo the others on retry.
   *
   * Result aggregation: builds a per-URL outcome list with simple bullet
   * lines and combines into a single 'ok-multi' reply via the existing
   * email-reply-builder template. resulting_event_id on the parent row
   * is set to the FIRST successfully-created event id so /admin/inbound-
   * emails still has a useful jump-link; other events are queryable via
   * source_url. Future improvement (separate PR): write actual child rows
   * with parent_email_id so admin sees one row per URL.
   *
   * Sequential, not parallel: simplicity > raw speed for a sub-10-URL
   * loop. CF Workflows allow long runs (we're well within budget) and
   * each step.do is independently retryable, so failures don't replay
   * the whole batch.
   */
  private async runMultiUrlPipeline(
    step: WorkflowStep,
    urls: string[],
    subject: string,
    fromAddress: string,
    hasAttachments: boolean,
    overflowed: boolean,
    // D1 (analyst, 2026-05-29 PM): pass the email body in so the
    // per-URL submitExtract calls can prefer body dates over the
    // per-page form's dates. Empty string when no body.
    emailBody: string = ""
  ): Promise<HandlerResult> {
    interface UrlOutcome {
      url: string;
      kind: "created" | "already-exists" | "extract-failed" | "fetch-failed" | "submit-failed";
      eventName?: string;
      eventSlug?: string;
      eventId?: string;
    }
    const outcomes: UrlOutcome[] = [];
    let firstCreatedEventId: string | null = null;

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      // Per-URL step labels include the index so the CF Workflows
      // dashboard can show which URL each step.do was for.
      const labelPrefix = `submit/multi[${i}]`;
      try {
        const fetched = await step.do(
          `${labelPrefix}/fetch-url`,
          {
            retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
            timeout: "30 seconds",
          },
          () => submitFetch(this.env, url)
        );
        const extracted = await step.do(
          `${labelPrefix}/ai-extract`,
          {
            retries: { limit: 1, delay: "10 seconds", backoff: "constant" },
            timeout: "30 seconds",
          },
          // D1 (analyst, 2026-05-29 PM): same body-priority pass-through
          // as the single-URL path. Email body is plumbed through as
          // the function arg.
          () => submitExtract(this.env, fetched, emailBody)
        );
        const dedup = await step.do(
          `${labelPrefix}/check-duplicate`,
          { retries: { limit: 2, delay: "5 seconds", backoff: "constant" }, timeout: "10 seconds" },
          () => submitCheckDuplicate(this.env, extracted)
        );
        if (dedup.isDuplicate && dedup.existingEventSlug) {
          outcomes.push({
            url,
            kind: "already-exists",
            eventName: dedup.existingEventName ?? extracted.event.name,
            eventSlug: dedup.existingEventSlug,
            eventId: dedup.existingEventId,
          });
          continue;
        }
        const submitted = await step.do(
          `${labelPrefix}/submit-event`,
          {
            retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
            timeout: "15 seconds",
          },
          () => submitEvent(this.env, extracted, fromAddress)
        );
        outcomes.push({
          url,
          kind: "created",
          eventName: submitted.eventName,
          eventSlug: submitted.slug,
          eventId: submitted.id,
        });
        if (!firstCreatedEventId) firstCreatedEventId = submitted.id;
      } catch (err) {
        // Per-URL failures degrade gracefully — the other URLs still run.
        // Map common prefixes to outcome kinds; everything else is a
        // generic extract-failed for the sender-facing list.
        const msg = err instanceof Error ? err.message : String(err);
        const kind = msg.startsWith("fetch-")
          ? "fetch-failed"
          : msg.startsWith("submit-")
            ? "submit-failed"
            : "extract-failed";
        outcomes.push({ url, kind });
      }
    }

    // Format the results block for the ok-multi template. One bullet
    // per URL; uses plain ✅/❌ glyphs that buildReply's HTML-escape pass
    // converts safely to entities.
    const resultsText = outcomes
      .map((o) => {
        switch (o.kind) {
          case "created":
            return `✅ "${o.eventName}" — pending review`;
          case "already-exists":
            return `✅ "${o.eventName}" — already in our directory: https://meetmeatthefair.com/events/${o.eventSlug}`;
          case "extract-failed":
            return `❌ Couldn't extract event details from ${o.url}`;
          case "fetch-failed":
            return `❌ Couldn't fetch ${o.url}`;
          case "submit-failed":
            return `❌ Extracted event from ${o.url} but couldn't save it — our team will follow up`;
        }
      })
      .join("\n");

    return {
      replyKind: "ok-multi",
      replyParams: {
        subject,
        eventCount: outcomes.length,
        resultsText,
        hasAttachments,
        overflowed,
      },
      status: "replied",
      resultingEventId: firstCreatedEventId,
      // No fetch_method on the parent row for multi-URL — different URLs
      // may have used different paths. The per-URL workflows handle their
      // own tracking via the step-output trail in the CF dashboard.
      fetchMethod: null,
      extractionMethod: "ai",
    };
  }
}

/**
 * Map per-field "high"/"medium"/"low" confidence to a reply tier.
 * Considers only the fields the submitter can confirm via a reply (name,
 * dates, venue) — `_extractId` and similar bookkeeping fields don't
 * factor in. Worst-case wins: any LOW-confidence critical field demotes
 * the whole reply to LOW.
 */
function computeReplyTier(
  fieldConfidence: Record<string, "high" | "medium" | "low"> | undefined
): "high" | "medium" | "low" {
  if (!fieldConfidence) return "high";
  const critical: Array<"name" | "startDate" | "venueName"> = ["name", "startDate", "venueName"];
  let worst: "high" | "medium" | "low" = "high";
  for (const field of critical) {
    const c = fieldConfidence[field];
    if (c === "low") return "low";
    if (c === "medium" && worst === "high") worst = "medium";
  }
  return worst;
}

/**
 * Comma-separated list of critical fields the extractor flagged
 * medium/low, for the MEDIUM/LOW reply templates to interpolate. Empty
 * string when nothing's uncertain (HIGH tier path).
 */
function summarizeUnsureFields(
  fieldConfidence: Record<string, "high" | "medium" | "low"> | undefined
): string {
  if (!fieldConfidence) return "";
  const labels: Array<[keyof typeof fieldConfidence, string]> = [
    ["name", "event name"],
    ["startDate", "date"],
    ["venueName", "venue"],
  ];
  const unsure = labels
    .filter(([f]) => {
      const c = fieldConfidence[f];
      return c === "medium" || c === "low";
    })
    .map(([, label]) => label);
  return unsure.join(", ");
}
