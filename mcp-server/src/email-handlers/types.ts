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
import type { SenderTrustTier } from "../intent-classifier.js";
import type { EmailAuthVerdict } from "../email-auth.js";

/** Discriminated tag matched by buildReply in email-reply-builder.ts.
 *  null means "send no auto-reply" (used by `unknown` catch-all). */
export type ReplyKind =
  // Submit-intent reply kinds (workflow-orchestrated; not a handler)
  | "ok"
  // B3 confidence-aware variants of ok. The workflow picks one based on
  // the extractor's per-field confidence: HIGH=ok, MEDIUM=ok-medium,
  // LOW=ok-low. All three still create a PENDING event — only the
  // sender-facing message differs.
  | "ok-medium"
  | "ok-low"
  // OPE-185 — a PENDING event was DRAFTED purely from the email body prose
  // (URL-less forwarded submission, or a URL that couldn't be fetched, e.g.
  // share.google returning 429). Lower confidence than the URL/attachment
  // paths, so the reply says "we drafted this from your message; the team will
  // review before publishing" — distinct copy per the OPE-6 STOP-gate. Still a
  // PENDING event (never auto-published).
  | "ok-low-body-extract"
  // B1 multi-URL: classifier returned sub_intent='multi_url'. Workflow
  // ran fetch+extract+submit sequentially per URL and produced a single
  // combined reply listing all per-URL outcomes (created, dedup-hit,
  // failed-extract). One feedback widget for the batch — per-event
  // widgets are a follow-up.
  | "ok-multi"
  | "no-url"
  // Fired when the submission had no real event URL but DID include
  // prose event details in the body, the B2 free-text extractor ran,
  // and the result didn't carry enough fields (name + start_date or
  // venue_name) to land as a PENDING event. Distinct from `no-url`
  // because the user already supplied details — asking them to "reply
  // with a URL" is dismissive. Distinct from `extract-failed` because
  // there was no URL to reference. Closes GH #244. drizzle/0079 covers
  // the inbound_emails persistence so the row still exists for admin
  // review even though the auto-reply was a soft fail.
  | "no-url-prose-failed"
  | "extract-failed"
  | "submit-failed"
  | "already-exists"
  // Cohort 2 (analyst, 2026-06-01) — MEDIUM-confidence dedup hit
  // (matchType=city_state_date or similar_name_date). Created a
  // PENDING event tagged with possible_duplicate_of, but the sender
  // is told it MAY be a duplicate of an existing listing and that an
  // operator will compare. Distinct from "already-exists" (HIGH-
  // confidence: workflow short-circuits) and from "ok-medium" (low
  // field confidence on a non-duplicate). Closes the K2-part-5
  // behavior gap deferred from PR #286.
  | "ok-medium-dup"
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
  // OPE-202 photo-intake lane acks. `photo-intake-ack` — an authenticated,
  // trusted sender: "received N photos", eligible for downstream vendor
  // processing. `photo-intake-held` — auth-fail or untrusted sender: received +
  // held for review, NOT eligible for auto-write. Both include the operational
  // tip to send full-size attachments so EXIF (GPS + timestamp) survives.
  | "photo-intake-ack"
  | "photo-intake-held"
  // OPE-203 — photos arrived from an authenticated, trusted sender, but we
  // could not pin WHICH fair they came from (no GPS/date, no geocoded venue in
  // range, nothing running that day, or two fairs at once). Distinct from
  // `photo-intake-held`, which means the SENDER wasn't trusted. This one asks
  // John to name the fair; that one tells him the mail was quarantined.
  | "photo-intake-unresolved"
  // OPE-254 Defect 2 — a reply naming the fair resolved one or more held
  // `photo-intake-unresolved` batches: photos were attached to the event
  // gallery. Confirms the match + counts, so John knows the recovery worked
  // without re-sending. Sent by the correction handler, not the photo-intake
  // one, because the reply lands as intent=correction.
  | "photo-intake-resolved"
  // UR1 Phase 1 (2026-06-04) — problem-report intake ack. Reassures the
  // sender that the report landed AND that operators get HIGH-priority
  // visibility when the report co-occurs with an active outage.
  | "problem-report-ack"
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
// string[] added for analyst D1 Phase 1 (additionalEventNames in the
// success reply). Arrays of primitives serialize cleanly through the
// Serializable<T> step boundary; arrays of objects don't.
export type ReplyParamValue = string | number | boolean | null | string[];
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
  /** Which extraction strategy produced the event. Only set for submit
   *  intent; null/undefined for other intents (no extraction happens).
   *  Persisted to inbound_emails.extraction_method at mark-done. See
   *  drizzle/0083.
   *  'thin' added 2026-05-31 (K7 Tier 1): deterministic salvage path —
   *  triggers inbound_emails.flagged_for_review=1 at mark-done so the
   *  operator review queue picks it up. */
  extractionMethod?: "json-ld" | "ai" | "free-text" | "mixed" | "thin" | null;
  /** OPE-174 — categorical failure bucket for the no-URL / prose-failed salvage
   *  branches (`no-fetchable-url`, `prose-extract-failed`), persisted to
   *  inbound_emails.extract_fail_reason at mark-done. Previously these branches
   *  bounced without recording any reason, so URL-less submissions were invisible
   *  in the source-quality telemetry (unlike the extract-failed path, which has
   *  logged a reason since K7.4). mark-done writes it only when set, so it never
   *  clobbers the extract-failed path's own direct write. */
  extractFailReason?: string | null;
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
  // Optional alert-dispatch surface — extended for UR1 C2 (2026-06-04).
  // Read by `problem-report` handler when it needs to push HIGH-severity
  // reports to the technical channel. Other handlers ignore. Optional
  // here because they're optional in the full Env too (no-op when unset).
  SLACK_WEBHOOK_URL_TECHNICAL?: string;
  ALERT_EMAIL_TECHNICAL?: string;
  EMAIL_JOBS?: Queue;
  /**
   * OPE-203 — R2 bucket holding the inbound attachments captured at receive
   * time (`inbound-attachments/<group>/...`, written by
   * email-handler.ts:captureAttachments). Read by `photo-intake` to pull EXIF
   * GPS + DateTimeOriginal off the ORIGINAL bytes.
   *
   * This binding was already present at runtime before being declared here:
   * the workflow's dispatch step passes `this.env` wholesale, and the workflow
   * Env has always carried VENDOR_ASSETS. HandlerEnv is a narrower view, so
   * the object was reachable but invisible to the type — same as
   * EMAIL_JOBS/SLACK_WEBHOOK_URL_TECHNICAL. Declaring it changes nothing at
   * runtime. Optional to match the workflow Env.
   */
  VENDOR_ASSETS?: R2Bucket;
  /**
   * OPE-204 — Workers AI binding, used by `photo-intake` to vision-identify
   * booths. Same story as VENDOR_ASSETS: already present at runtime (the
   * workflow Env declares `AI?: Ai`), merely undeclared on this narrower view.
   */
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  /**
   * OPE-204 / OPE-6 gate. Booth identification runs ONLY when this equals
   * "true". Default OFF: it spends Workers AI on every inbound photo and stages
   * rows for review. Enable per John's go, after he's seen the model's accuracy
   * on real booth photos.
   */
  PHOTO_VISION_ENABLED?: string;
}

/**
 * Per-call context passed by the workflow. The sessionId is the
 * workflow instanceId — same one used by logError calls in the
 * surrounding workflow steps, so admin can correlate handler logs
 * with the workflow's step traces.
 */
export interface HandlerCtx {
  sessionId: string;
  /** OPE-202 — the sender's trust tier + email-auth verdict, computed once in
   *  the entrypoint (email-handler.ts) and threaded through the workflow so a
   *  handler can gate on "authenticated + trusted" without re-deriving. Default
   *  "unknown"/"unknown" for handlers/paths that don't set them. */
  senderTrust: SenderTrustTier;
  emailAuth: EmailAuthVerdict;
}

/** Standardized signature for every handler. Throws on failure;
 *  the workflow's outer try/catch records the error and maps it
 *  to inbound_emails.status='failed'. */
export type HandlerFn = (
  env: HandlerEnv,
  ctx: HandlerCtx,
  row: InboundEmail
) => Promise<HandlerResult>;
