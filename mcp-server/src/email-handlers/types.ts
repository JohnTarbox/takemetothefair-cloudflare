/**
 * Shared types for per-intent inbound-email handlers.
 *
 * Each handler in `email-handlers/<intent>.ts` exports an async
 * `handle(env, ctx, row): Promise<HandlerResult>` function. The
 * `InboundEmailWorkflow`'s `dispatch` step calls the handler matching
 * the email's resolved intent (see ../email-intents.ts).
 *
 * Failure contract (post-PR May 2026):
 *   - Handlers MUST throw on failure. Plain `Error` triggers the workflow
 *     step's retry budget; `NonRetryableError` (from `cloudflare:workflows`)
 *     short-circuits retries for permanent failures (4xx, validation).
 *   - Handlers MAY swallow errors and still return a success-shaped result
 *     ONLY when the user's intent was satisfied another way (e.g., the
 *     entrypoint forwarded the message to admin's Gmail, so even if our
 *     internal logging/tracking failed, the human admin still sees it).
 *     This is the exception, not the default.
 *
 * The `submit` intent is special — it's not in this HandlerFn table
 * because the workflow orchestrates its 3 sub-steps (fetch / extract /
 * submit) directly, each as its own `step.do`. See workflows/inbound-email.ts
 * and email-handlers/submit.ts (which now exports 3 leg functions, not a
 * combined handle).
 */

import type { InboundEmail } from "@takemetothefair/db-schema";

/** Discriminated tag matched by buildReply in email-reply-builder.ts.
 *  null means "send no auto-reply" (used by `unknown` catch-all). */
export type ReplyKind =
  // Submit-intent reply kinds (workflow-orchestrated; not a handler)
  | "ok"
  | "no-url"
  | "extract-failed"
  | "submit-failed"
  | "already-exists"
  // Terminal fail emitted by the stale-sweep when a row's
  // recovery_attempt_n exceeds the cap. Not produced by the workflow
  // itself — sent directly from inbound-email-stale-sweep.ts after
  // MAX_RECOVERY_ATTEMPTS deterministic failures, to break the recreate
  // loop the docblock warns about. See drizzle/0082.
  | "sweep-exceeded"
  // Post-review notification: fires when admin transitions a
  // submitter-attributed event from PENDING/TENTATIVE → APPROVED.
  // Not a handler reply — pushed onto EMAIL_JOBS by the approval-
  // notification helper, drained by queue-consumers.ts. See
  // src/lib/approval-notification.ts.
  | "submission-approved"
  // Generic per-intent acks (initial / timeout fallback)
  | "correction-ack"
  | "support-ack"
  | "press-ack"
  | "unsubscribe-ack"
  | "source-suggestion-ack"
  // Admin-decision-tailored kinds (PR-D, waitForEvent flow)
  | "correction-applied"
  | "correction-rejected"
  | "correction-needs-info"
  | "press-handled"
  | "press-needs-info";

/** Status to write back to inbound_emails.status when the workflow ends.
 *  Failed paths no longer return this — they throw, and the workflow's
 *  outer catch records status='failed' from the caught error. */
export type FinalStatus = "replied" | "forwarded";

/**
 * Values that can appear in `HandlerResult.replyParams`. Restricted to
 * JSON-serializable primitives because the HandlerResult is the dispatch
 * step's output in InboundEmailWorkflow — CF Workflows enforces that
 * step.do() return types satisfy `Serializable<T>`, which excludes
 * arbitrary `unknown`.
 */
export type ReplyParamValue = string | number | boolean | null;
export type ReplyParams = Record<string, ReplyParamValue>;

/**
 * What a per-intent handler returns to the workflow on success.
 *
 * - `replyKind: null` skips the send-reply step entirely (e.g., unknown
 *   catch-all where we forwarded to admin but don't auto-ack the sender).
 * - `replyParams` is passed to buildReply() — primitive-only fields per
 *   the workflow serialization constraint above. Keys + meanings are
 *   documented in email-reply-builder.ts's renderText switch.
 */
export interface HandlerResult {
  replyKind: ReplyKind | null;
  replyParams?: ReplyParams;
  status: FinalStatus;
  /** Event this submission resolved against. Dual-purpose, keyed by
   *  replyKind: 'ok' → new event id; 'already-exists' → matched existing
   *  event id; anything else → null. Workflow writes this to
   *  inbound_emails.resulting_event_id at mark-done. */
  resultingEventId?: string | null;
  /** Which fetch path produced the URL content. Only set for submit intent;
   *  null/undefined for other intents (no fetch happens). Persisted to
   *  inbound_emails.fetch_method at mark-done. See drizzle/0078. */
  fetchMethod?: "standard" | "browser-rendering" | "failed" | null;
}

/**
 * Subset of env that handlers need. Narrower than the full Worker Env —
 * handlers shouldn't reach into Workflow bindings, queues, etc. that
 * aren't theirs.
 */
export interface HandlerEnv {
  DB: D1Database;
  MAIN_APP_URL: string;
  INTERNAL_API_KEY: string;
}

/**
 * Per-call context passed by the workflow. The sessionId is the
 * workflow instanceId — same one used by logError calls in the
 * surrounding workflow steps, so admin can correlate handler logs
 * with the workflow's step traces.
 */
export interface HandlerCtx {
  sessionId: string;
}

/** Standardized signature for every handler. Throws on failure;
 *  the workflow's outer try/catch records the error and maps it
 *  to inbound_emails.status='failed'. */
export type HandlerFn = (
  env: HandlerEnv,
  ctx: HandlerCtx,
  row: InboundEmail
) => Promise<HandlerResult>;
