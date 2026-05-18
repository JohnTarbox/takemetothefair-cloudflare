/**
 * Shared types for per-intent inbound-email handlers.
 *
 * Each handler in `email-handlers/<intent>.ts` exports an async
 * `handle(env, ctx, row): Promise<HandlerResult>` function. The
 * `InboundEmailWorkflow`'s `dispatch` step calls the handler matching
 * the email's resolved intent (see ../email-intents.ts).
 *
 * Handlers should be:
 *   - Idempotent (the `dispatch` step may retry up to 2x)
 *   - Pure of side effects beyond what they declare via HandlerResult
 *     (DB writes are allowed; mutating shared module state is not)
 *   - Tolerant of partial data — `bodyTextExcerpt` is only 500 chars;
 *     handlers needing full body should re-read raw from D1 if we ever
 *     store it (today we don't — body_text_excerpt is the most we keep)
 */

import type { InboundEmail } from "@takemetothefair/db-schema";

/** Discriminated tag matched by buildReply in email-reply-builder.ts.
 *  null means "send no auto-reply" (used by `unknown` catch-all). */
export type ReplyKind =
  // Original submit-intent kinds (preserved from PR #174)
  | "ok"
  | "no-url"
  | "extract-failed"
  | "submit-failed"
  // New per-intent acknowledgment kinds (PR for multi-intent rework)
  | "correction-ack"
  | "support-ack"
  | "press-ack"
  | "unsubscribe-ack";

/** Status to write back to inbound_emails.status when the workflow ends. */
export type FinalStatus = "replied" | "forwarded" | "failed";

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
 * What a per-intent handler returns to the workflow.
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
  error?: string;
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

/** Standardized signature for every handler. */
export type HandlerFn = (
  env: HandlerEnv,
  ctx: HandlerCtx,
  row: InboundEmail
) => Promise<HandlerResult>;
