/**
 * Inbound email entrypoint — receives every message Cloudflare Email
 * Routing forwards to this Worker, persists a row in `inbound_emails`,
 * and dispatches the heavy work into `InboundEmailWorkflow`.
 *
 * Routing semantics live in `email-intents.ts` (pure function map from
 * recipient address → intent). Per-intent handlers live in
 * `email-handlers/<intent>.ts`. The workflow lives in
 * `workflows/inbound-email.ts`. The auto-reply templates live in
 * `email-reply-builder.ts`.
 *
 * This file's job is the must-be-synchronous-in-the-email-handler work
 * only:
 *   1. PostalMime.parse the raw message
 *   2. Per-sender KV rate-limit (drops the message silently if hit —
 *      anti-reflection; replying to a rate-limited sender creates a
 *      spam vector)
 *   3. Resolve intent via the static map
 *   4. message.forward() to admin Gmail synchronously if the intent
 *      requires it (the ForwardableEmailMessage object dies the moment
 *      this handler returns; workflow steps cannot forward)
 *   5. INSERT a row in inbound_emails so the workflow has state to
 *      read from
 *   6. env.INBOUND_EMAIL.create() the workflow instance
 *   7. UPDATE the row's workflow_instance_id
 *
 * The full pipeline (URL fetch / AI extract / submit / auto-reply /
 * forwards for non-trivial intents) runs in the workflow's step.do
 * calls, with per-step retry budgets.
 *
 * Diagnostics: every step's sessionId is the workflow's instanceId;
 * filter /admin/logs by `source LIKE 'mcp:email-handler%'` to trace.
 */

import PostalMime, { type Email } from "postal-mime";
import { logError } from "./logger.js";
import { getDb, type Db } from "./db.js";
import { inboundEmails, inboundEmailSenders, users } from "./schema.js";
import { eq, sql } from "drizzle-orm";
import { resolveIntent, shouldForwardToAdmin, type EmailIntent } from "./email-intents.js";
import {
  classifyIntent,
  type AiBinding,
  type ClassifiedIntent,
  type ClassifiedSubIntent,
  type IntentClassification,
  type SenderTrustTier,
  CLASSIFIER_VERSION,
  DEFAULT_CONFIDENCE_THRESHOLD,
  SPAM_QUARANTINE_THRESHOLD,
} from "./intent-classifier.js";
import { hasMultiIntentOrSpecialSignal, isReplyToOurThread } from "./intent-fastpath.js";
import { isDenylistedHost } from "./url-denylist.js";
import { parseEmailAuth } from "./email-auth.js";
import { isNonActionableSender } from "./email-handlers/audit-sender.js";

// ---------------------------------------------------------------------------
// Env shape required by this module
// ---------------------------------------------------------------------------
export interface EmailHandlerEnv {
  /** D1 binding — `inbound_emails` persistence + error_logs. */
  DB: D1Database;
  /** OAuth KV is reused with an "email-submit:" prefix for per-sender
   *  rate limiting. Intentional cross-use to avoid a dedicated binding. */
  OAUTH_KV: KVNamespace;
  /** Outbound auto-reply queue — drained by handleEmailBatch in
   *  queue-consumers.ts → env.EMAIL.send (CF Email Sending). */
  EMAIL_JOBS?: Queue<unknown>;
  /** Main app base URL — used by per-intent handlers' main-app calls. */
  MAIN_APP_URL: string;
  /** Shared secret for internal API calls — same convention as cron
   *  sweeps + workflow steps. */
  INTERNAL_API_KEY: string;
  /** Where the entrypoint forwards messages for non-`submit` intents.
   *  Must be a verified destination in Cloudflare Email Routing. */
  SUBMIT_ADMIN_FORWARD?: string;
  /** The InboundEmailWorkflow binding. Uses the global Workflow type
   *  from @cloudflare/workers-types so the retention / id options on
   *  .create() stay in sync with the platform's actual signature. */
  INBOUND_EMAIL: Workflow<{ messageRowId: string; intent: EmailIntent }>;
  /** Workers AI binding for the intent classifier. Optional so unit
   *  tests + non-AI environments can omit it; missing → classifier
   *  silently skipped, address-based routing only. */
  AI?: AiBinding;
  /** OPE-68 — shared vendor-assets R2 bucket. Used to persist inbound
   *  poster/PDF attachment bytes at receive-time (they're otherwise
   *  discarded — Email Workers only expose attachment bytes here, not in
   *  the Workflow). Optional so tests / non-R2 envs can omit it; when
   *  unbound, attachment capture no-ops and ingestion proceeds exactly as
   *  before. */
  VENDOR_ASSETS?: R2Bucket;
}

// ForwardableEmailMessage is global per @cloudflare/workers-types.
export type { ForwardableEmailMessage } from "@cloudflare/workers-types";

// Per-sender rate-limit tiers. Daily quota varies by sender's account
// state. The anonymous floor preserves anti-reflection behavior for
// senders who don't have a user row (random forged addresses, spammers).
// Verified users get more capacity scaled to their typical legitimate
// usage. Operators (ADMIN) effectively get unlimited for normal use.
// See resolveRateLimitForSender below for the lookup logic.
const ANONYMOUS_LIMIT = 5;
const ROLE_LIMITS: Record<string, number> = {
  USER: 10, // established verified consumer
  VENDOR: 20, // submits applications regularly
  PROMOTER: 30, // actively manages events
  ADMIN: 100, // operator; effectively unlimited for normal use
};
const PER_SENDER_WINDOW_SEC = 86_400;
const MAX_BODY_LEN = 50_000; // chars of body retained for URL extraction
const BODY_EXCERPT_LEN = 500; // chars stored for admin preview
const SOURCE = "mcp:email-handler";

// OPE-68 attachment-capture caps. Per-attachment size ceiling (skip larger)
// and a total-count ceiling (only the first N image/PDF attachments) so a
// pathological many-attachment message can't blow the receive-time budget.
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB per attachment
const ATTACHMENT_MAX_COUNT = 5; // first 5 image/PDF attachments

// ---------------------------------------------------------------------------
// Entry point — wired from src/index.ts default export
// ---------------------------------------------------------------------------
export async function handleInboundEmail(
  message: import("@cloudflare/workers-types").ForwardableEmailMessage,
  env: EmailHandlerEnv,
  ctx: ExecutionContext
): Promise<void> {
  // sessionId is used for entrypoint-time logs; the workflow then
  // creates its own instanceId for the workflow-step logs. Both end up
  // in /admin/logs filterable by source.
  const sessionId = crypto.randomUUID();
  const toAddr = message.to.toLowerCase().trim();

  // Outer try/catch — anything unhandled gets a row in error_logs and
  // an admin-forward attempt before re-throwing (CF Email Routing
  // surfaces it in their Activity view).
  try {
    // 1. Parse
    let parsed: Email;
    try {
      parsed = await PostalMime.parse(message.raw);
    } catch (err) {
      await logError(env.DB, {
        source: SOURCE,
        message: "PostalMime parse failed",
        error: err,
        sessionId,
        context: { from: message.from, to: toAddr, rawSize: message.rawSize },
      });
      await forwardToAdminBestEffort(message, env, `parse-failed: ${errMsg(err)}`, sessionId);
      return;
    }

    const fromAddr = (parsed.from?.address || message.from || "").toLowerCase().trim();
    const subject = (parsed.subject || "").slice(0, 200);
    const bodyText = (parsed.text || "").slice(0, MAX_BODY_LEN);
    const bodyHtml = parsed.html || "";
    const bodyTextExcerpt = bodyText.slice(0, BODY_EXCERPT_LEN);
    const attachmentCount = parsed.attachments?.length ?? 0;

    if (!fromAddr) {
      await logError(env.DB, {
        level: "warn",
        source: SOURCE,
        message: "missing from-address; forwarding to admin",
        sessionId,
        context: { to: toAddr, subject, rawSize: message.rawSize },
      });
      await forwardToAdminBestEffort(message, env, "missing-from", sessionId);
      return;
    }

    // 1b. OPE-74 — never-actionable audit/system senders. Our own outbound
    //     notifier (notify@meetmeatthefair.com) loops sent copies back into
    //     inbound_emails as audit copies, and generic system addresses
    //     (noreply@ / postmaster@ / mailer-daemon@) are auto-generated mail a
    //     human can never act on. Left alone, the classifier misfires them into
    //     the human-triage `waiting` queue as pure noise (5 rows sat 4–5 days
    //     each). Short-circuit here — same detect → write-terminal-row → return
    //     shape as the spam-quarantine early return below — recording a TERMINAL
    //     `audit-noop` row for the audit trail BEFORE the intent classifier +
    //     workflow ever run. Best-effort: a failed insert logs and still returns
    //     (never bounces the message, never re-runs the pipeline).
    const nonActionable = isNonActionableSender(fromAddr);
    if (nonActionable.match) {
      try {
        await insertAuditNoopRow(getDb(env.DB), {
          fromAddr,
          toAddr,
          subject,
          bodyTextExcerpt,
          attachmentCount,
          rawSize: message.rawSize,
          messageId: (parsed.messageId || "").trim() || null,
          reason: nonActionable.reason,
        });
        await logError(env.DB, {
          level: "info",
          source: SOURCE,
          message:
            "non-actionable audit/system sender; recorded audit-noop, skipped classifier + workflow",
          sessionId,
          context: { from: fromAddr, to: toAddr, reason: nonActionable.reason },
        }).catch(() => {});
      } catch (err) {
        await logError(env.DB, {
          source: SOURCE,
          message: "failed to insert audit-noop row for non-actionable sender",
          error: err,
          sessionId,
          context: { from: fromAddr, to: toAddr, reason: nonActionable.reason },
        }).catch(() => {});
      }
      return;
    }

    // 2. Rate limit (silent drop on hit — anti-reflection)
    // Tiered: ADMIN/PROMOTER/VENDOR/USER verified senders get higher
    // daily allowances than the anonymous floor. See ROLE_LIMITS and
    // resolveRateLimitForSender for the lookup logic.
    const senderLimit = await resolveRateLimitForSender(env.DB, fromAddr);
    const allowed = await checkSenderRateLimit(env.OAUTH_KV, fromAddr, senderLimit);
    if (!allowed) {
      await logError(env.DB, {
        level: "warn",
        source: SOURCE,
        message: "rate-limited sender; dropped without reply or forward",
        sessionId,
        context: {
          from: fromAddr,
          subject,
          to: toAddr,
          limit: senderLimit,
          windowSec: PER_SENDER_WINDOW_SEC,
        },
      });
      return;
    }

    // 3. Resolve address-based intent (always computed — used as
    //    fallback when classifier confidence is below threshold).
    const addressIntent = resolveIntent(toAddr);

    // 3b. Look up sender trust tier (B6, drizzle/0075). Drives the
    //     trusted-sender fast-path decision below. Failure-safe: any
    //     lookup error treats the sender as 'unknown'.
    const senderTrust = await lookupSenderTrust(env.DB, fromAddr);

    // 3b-ii. WS3e (2026-06-11) — verify the message actually authenticated
    //     before the trusted fast-path honors a (spoofable) From address.
    //     Cloudflare Email Routing attaches an Authentication-Results header;
    //     parseEmailAuth condenses it to pass/fail/unknown. We only DOWNGRADE
    //     on a proven "fail" (fail-open on "unknown" so existing trusted
    //     senders aren't broken if the header is absent). Log trusted senders
    //     whose mail isn't a clean "pass" so prod can confirm header presence
    //     before we tighten the gate to require "pass".
    const emailAuth = parseEmailAuth(message.headers?.get("Authentication-Results"));
    if (senderTrust === "trusted" && emailAuth !== "pass") {
      await logError(env.DB, {
        level: emailAuth === "fail" ? "warn" : "info",
        message:
          emailAuth === "fail"
            ? "trusted sender failed email auth — fast-path downgraded (possible From spoof)"
            : "trusted sender email auth unverifiable (no/none Authentication-Results)",
        source: "email-handler:ws3e-auth-gate",
        context: { from: fromAddr, to: toAddr, emailAuth },
      });
    }

    // 3c. Compute the routing decision: maybe run the classifier, maybe
    //     short-circuit via the trusted-sender fast-path, always end
    //     with a `routed` array of {intent, ...} for the INSERT loop.
    const routing = await computeRouting({
      env,
      sessionId,
      addressIntent,
      senderTrust,
      emailAuth,
      toAddr,
      fromAddr,
      subject,
      bodyText,
      bodyHtml,
      inReplyTo: parsed.inReplyTo ?? null,
      references: parsed.references ?? null,
      attachmentCount,
      attachmentTypes: (parsed.attachments ?? [])
        .map((a) => a.mimeType || "")
        .filter((t) => t.length > 0),
    });

    // 4. Spam quarantine (spec §C.6). When the classifier confidently
    //    flagged spam, we INSERT for audit then bail out — no forward,
    //    no workflow create, no auto-reply. Mirrors the rate-limit
    //    silent-drop pattern above.
    if (routing.spamQuarantine) {
      await insertSpamAuditRow({
        env,
        sessionId,
        fromAddr,
        toAddr,
        subject,
        bodyTextExcerpt,
        message,
        parsed,
        attachmentCount,
        routing,
      });
      return;
    }

    // 5. Forward to admin synchronously if applicable. Decision is
    //    based on the FIRST routed intent (parent of multi-intent rides
    //    its own forward decision via the catch-all path). Lifecycle:
    //    ForwardableEmailMessage cannot survive into a workflow step —
    //    this is the only chance.
    const primaryRouted = routing.routed[0];
    if (shouldForwardToAdmin(primaryRouted.intent)) {
      await forwardToAdminBestEffort(message, env, `intent:${primaryRouted.intent}`, sessionId);
    }

    // 6. Pick URL from body (used by `submit` / `new_event` intent
    //    only, but stored unconditionally so the row is self-contained
    //    for future intents).
    const parsedUrl = pickPrimaryUrl(bodyText, bodyHtml);

    // 6b. Capture Message-ID for dedup. RFC 5322 §3.6.4 guarantees a
    //     globally unique value when present; absence is a real signal
    //     (automated senders sometimes omit it) — those messages skip
    //     dedup and proceed with the legacy "always insert" behavior.
    const messageId = (parsed.messageId || "").trim() || null;

    // 6c. OPE-68 — capture poster/PDF attachment bytes to R2 at receive-time.
    //     Email Workers expose attachment content ONLY here (the Workflow
    //     can't re-fetch it), so this is the one chance to persist them. This
    //     is STRICTLY best-effort + additive: the whole block is try/caught so
    //     a storage/parse failure NEVER throws, blocks, or changes ingestion —
    //     on any failure we fall through to exactly today's behavior with
    //     attachmentRefsJson=null. Same posture as the best-effort analytics /
    //     email sends elsewhere. Runs AFTER the spam-quarantine early-return so
    //     junk attachments are never stored.
    let attachmentRefsJson: string | null = null;
    if (attachmentCount > 0) {
      try {
        // Derive a stable, path-safe group id from the Message-ID so a
        // redelivery overwrites the same R2 keys (idempotent — no orphans)
        // rather than storing a fresh copy under a random id.
        const safeMsgId = messageId
          ? messageId
              .replace(/[^a-zA-Z0-9._-]+/g, "-")
              .replace(/^-+|-+$/g, "")
              .slice(0, 80)
          : "";
        const groupId = safeMsgId || crypto.randomUUID();
        const refs = await captureAttachments(env.VENDOR_ASSETS, groupId, parsed.attachments);
        if (refs.length > 0) attachmentRefsJson = JSON.stringify(refs);
      } catch (err) {
        await logError(env.DB, {
          level: "warn",
          source: SOURCE,
          message: "attachment capture failed; continuing without attachment_refs",
          error: err,
          sessionId,
          context: { from: fromAddr, to: toAddr, attachmentCount },
        }).catch(() => {});
      }
    }

    // 7. INSERT inbound_emails row(s). Single-intent → one row.
    //    Multi-intent → one parent row (intent='multi') + N child
    //    rows (parent_email_id → parent.id). Parent row dedups on
    //    message_id; children share the parent's message_id is fine
    //    because the partial UNIQUE doesn't cover children (their
    //    messageId is null — see the .map below). The first multi-
    //    intent INSERT also acts as the dedup gate for the whole
    //    family — if the parent INSERT no-ops on conflict, we skip
    //    children too (same delivery already being handled).
    //
    //    Why .onConflictDoNothing without a target: see the
    //    pre-classifier comment block below — same SQLite partial-
    //    index limitation, same workaround.
    const now = new Date();
    const db = getDb(env.DB);
    const isMulti = routing.routed.length > 1;

    let parentRowId: string | null = null;
    if (isMulti) {
      parentRowId = crypto.randomUUID();
      let parentInserted: { id: string }[];
      try {
        parentInserted = await db
          .insert(inboundEmails)
          .values({
            id: parentRowId,
            receivedAt: now,
            fromAddress: fromAddr,
            toAddress: toAddr,
            subject: subject || null,
            intent: "multi",
            status: "received",
            workflowInstanceId: null,
            bodyTextExcerpt: bodyTextExcerpt || null,
            parsedUrl,
            attachmentCount,
            attachmentRefs: attachmentRefsJson,
            rawSize: message.rawSize,
            error: null,
            messageId,
            classifiedIntent: "multi" as ClassifiedIntent,
            classifiedSubIntent: null,
            classifiedConfidence: routing.aggregateConfidence,
            classifiedRationale: routing.aggregateRationale,
            classifiedAt: now,
            classifierVersion: routing.classifierVersion,
            routingSource: routing.routingSource,
            routedToWorkflow: null,
            flaggedForReview: routing.flaggedForReview ? 1 : 0,
            parentEmailId: null,
            createdAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: inboundEmails.id });
      } catch (err) {
        await logError(env.DB, {
          source: SOURCE,
          message: "failed to insert multi-intent parent row; aborting",
          error: err,
          sessionId,
          context: { from: fromAddr, to: toAddr, subject },
        });
        return;
      }
      if (parentInserted.length === 0) {
        await logError(env.DB, {
          level: "warn",
          source: SOURCE,
          message: "duplicate inbound delivery (multi-intent); skipping",
          sessionId,
          context: { from: fromAddr, to: toAddr, subject, messageId },
        });
        return;
      }
    }

    // Insert one row per routed entry. For single-intent, this is the
    // sole row. For multi-intent, these are children of parentRowId.
    const childRowIds: string[] = [];
    for (let i = 0; i < routing.routed.length; i++) {
      const r = routing.routed[i];
      const rowId = crypto.randomUUID();
      let inserted: { id: string }[];
      try {
        inserted = await db
          .insert(inboundEmails)
          .values({
            id: rowId,
            receivedAt: now,
            fromAddress: fromAddr,
            toAddress: toAddr,
            subject: subject || null,
            intent: r.intent,
            status: "received",
            workflowInstanceId: null,
            bodyTextExcerpt: bodyTextExcerpt || null,
            parsedUrl: r.refUrl ?? parsedUrl,
            attachmentCount,
            attachmentRefs: attachmentRefsJson,
            rawSize: message.rawSize,
            error: null,
            // Single-intent rows carry messageId for dedup; child rows
            // get null so the partial-unique on message_id doesn't
            // collide across the family.
            messageId: parentRowId ? null : messageId,
            classifiedIntent: r.classifiedIntent,
            classifiedSubIntent: r.classifiedSubIntent,
            classifiedConfidence: r.confidence,
            classifiedRationale: r.rationale,
            classifiedAt: routing.classifierVersion ? now : null,
            classifierVersion: routing.classifierVersion,
            routingSource: r.routingSource,
            routedToWorkflow: null,
            flaggedForReview: r.flaggedForReview ? 1 : 0,
            parentEmailId: parentRowId,
            createdAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: inboundEmails.id });
      } catch (err) {
        await logError(env.DB, {
          source: SOURCE,
          message: `failed to insert inbound_emails row [${i}]; aborting remaining`,
          error: err,
          sessionId,
          context: { from: fromAddr, to: toAddr, subject, intent: r.intent },
        });
        return;
      }
      if (inserted.length === 0) {
        // Should only happen for single-intent rows (messageId dedup).
        // Multi-intent children have null messageId; their parent INSERT
        // already handled the dedup gate.
        await logError(env.DB, {
          level: "warn",
          source: SOURCE,
          message: "duplicate inbound delivery; skipping workflow create",
          sessionId,
          context: { from: fromAddr, to: toAddr, subject, intent: r.intent, messageId },
        });
        return;
      }
      childRowIds.push(rowId);
    }

    // 8. Create workflow instance(s). One per child row. Spec §C.5
    //    caps multi-intent at 4 children; classifier already enforced
    //    this when building the routed array.
    const workflowInstanceIds: string[] = [];
    for (let i = 0; i < childRowIds.length; i++) {
      const rowId = childRowIds[i];
      const r = routing.routed[i];
      try {
        const instance = await env.INBOUND_EMAIL.create({
          params: { messageRowId: rowId, intent: r.intent },
          retention: { successRetention: "7 days", errorRetention: "7 days" },
        });
        workflowInstanceIds.push(instance.id);
      } catch (err) {
        // Workflow creation failed — row is still in 'received' state;
        // the stale-row sweep (commit 10f0e2e) will retry it. Don't
        // abort siblings; each child's workflow is independent.
        workflowInstanceIds.push("");
        await logError(env.DB, {
          source: SOURCE,
          message: "INBOUND_EMAIL.create failed; row remains in 'received' state",
          error: err,
          sessionId,
          context: { messageRowId: rowId, intent: r.intent, from: fromAddr },
        });
      }
    }

    ctx.waitUntil(
      (async () => {
        try {
          for (let i = 0; i < childRowIds.length; i++) {
            const id = workflowInstanceIds[i];
            if (!id) continue;
            await db
              .update(inboundEmails)
              .set({ workflowInstanceId: id })
              .where(eq(inboundEmails.id, childRowIds[i]));
          }
        } catch (err) {
          await logError(env.DB, {
            level: "warn",
            source: SOURCE,
            message: "failed to write workflow_instance_id back to row(s)",
            error: err,
            sessionId,
            context: { childRowIds, workflowInstanceIds },
          });
        }
      })()
    );
  } catch (err) {
    await logError(env.DB, {
      source: SOURCE,
      message: "unhandled exception in email entrypoint",
      error: err,
      sessionId,
      context: { from: message.from, to: toAddr, rawSize: message.rawSize },
    }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// URL extraction (pure)
// ---------------------------------------------------------------------------

function cleanUrl(raw: string): string | null {
  const u = raw.trim().replace(/^[<("']+|[>)"',.;]+$/g, "");
  try {
    const p = new URL(u);
    if (p.protocol !== "http:" && p.protocol !== "https:") return null;
    return p.toString();
  } catch {
    return null;
  }
}

export function pickPrimaryUrl(text: string, html: string): string | null {
  // Tracking/redirect hosts (Mailchimp click-trackers, URL shorteners,
  // ESP wrappers) are filtered via url-denylist.ts before they can
  // become `parsedUrl`. Forwarded marketing emails surface those
  // before the actual event link; treating one as the event URL
  // caused analyst K1 (2026-05-29 PM) — the AI extractor returned
  // zero events from a Mailchimp redirect page and the sender got an
  // `extract-failed` reply even though her body had name + date in
  // plain text. With the denylisted URL skipped, either the next
  // real URL wins OR (more commonly with forwards) parsedUrl ends up
  // null and the message routes to the free-text branch.
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const cleaned = cleanUrl(m[0]);
    if (cleaned && !isDenylistedHost(cleaned)) return cleaned;
  }
  for (const m of html.matchAll(/href=["']([^"']+)["']/g)) {
    const cleaned = cleanUrl(m[1]);
    if (cleaned && !isDenylistedHost(cleaned)) return cleaned;
  }
  return null;
}

/**
 * Collect ALL distinct URLs from text + html body for B1 multi-URL
 * submission fan-out. Order preserved (text URLs in document order,
 * then html href URLs that weren't already seen in text). Deduplicates
 * on the cleaned-URL string after normalization via cleanUrl.
 *
 * `cap` bounds the result length — we hard-stop at the caller's cap
 * BEFORE returning, so admin-forward-on-overflow logic in the workflow
 * can detect "the email had more URLs than we processed" by comparing
 * the returned length to the cap.
 */
export function extractAllUrls(text: string, html: string, cap: number = 10): string[] {
  // Same denylist filter as pickPrimaryUrl — see that function's comment
  // block. Critical for multi-URL submissions too: B1 fan-out shouldn't
  // try to fetch a Mailchimp click-tracker as one of its N URLs.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const cleaned = cleanUrl(m[0]);
    if (cleaned && !isDenylistedHost(cleaned) && !seen.has(cleaned)) {
      seen.add(cleaned);
      out.push(cleaned);
      if (out.length >= cap) return out;
    }
  }
  for (const m of html.matchAll(/href=["']([^"']+)["']/g)) {
    const cleaned = cleanUrl(m[1]);
    if (cleaned && !isDenylistedHost(cleaned) && !seen.has(cleaned)) {
      seen.add(cleaned);
      out.push(cleaned);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// OPE-68 — attachment capture (best-effort; NEVER throws into the handler)
// ---------------------------------------------------------------------------

/** One persisted attachment. Serialized as a JSON array into
 *  inbound_emails.attachment_refs. `key` is the R2 object key in the
 *  mmatf-vendor-assets bucket. */
export interface AttachmentRef {
  key: string;
  name: string;
  mimeType: string;
  size: number;
}

/** Minimal attachment shape captured — matches postal-mime's Attachment
 *  (subset). Kept local so the helper is unit-testable without postal-mime. */
interface CapturableAttachment {
  filename: string | null;
  mimeType: string;
  content: ArrayBuffer | Uint8Array | string;
}

/** Filesystem-safe attachment name for the R2 key. Collapses anything that
 *  isn't a safe filename char to a dash, trims, and caps length. */
function sanitizeAttachmentName(name: string | null, index: number): string {
  const base = (name || `attachment-${index}`).trim();
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : `attachment-${index}`;
}

/** Normalize postal-mime attachment content to bytes for sizing + R2 put.
 *  Binary attachments arrive as ArrayBuffer/Uint8Array; a string body (rare,
 *  e.g. utf8 text parts mislabeled) is UTF-8 encoded. Returns null when the
 *  content can't be turned into non-empty bytes. */
function attachmentBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array | null {
  let bytes: Uint8Array;
  if (typeof content === "string") {
    bytes = new TextEncoder().encode(content);
  } else if (content instanceof Uint8Array) {
    bytes = content;
  } else {
    bytes = new Uint8Array(content);
  }
  return bytes.byteLength > 0 ? bytes : null;
}

/**
 * Persist inbound image/PDF attachments to R2 and return their refs.
 *
 * Purely best-effort: every R2 put is individually try/caught so a single
 * failed attachment doesn't abort the rest, and a missing bucket binding
 * (tests / non-R2 envs) short-circuits to an empty result. Callers wrap the
 * whole thing in their own try/catch too — this helper never throws.
 *
 * Only `image/*` and `application/pdf` attachments are stored, within a
 * per-attachment size cap (ATTACHMENT_MAX_BYTES) and a total-count cap
 * (ATTACHMENT_MAX_COUNT). Non-media attachments are skipped.
 *
 * Exported for unit tests.
 */
export async function captureAttachments(
  bucket: R2Bucket | undefined,
  groupId: string,
  attachments: CapturableAttachment[] | undefined
): Promise<AttachmentRef[]> {
  if (!bucket || !attachments || attachments.length === 0) return [];
  const refs: AttachmentRef[] = [];
  let stored = 0;
  for (let i = 0; i < attachments.length; i++) {
    if (stored >= ATTACHMENT_MAX_COUNT) break;
    const a = attachments[i];
    const mime = (a.mimeType || "").toLowerCase();
    const isImage = mime.startsWith("image/");
    const isPdf = mime === "application/pdf";
    if (!isImage && !isPdf) continue;
    const bytes = attachmentBytes(a.content);
    if (!bytes || bytes.byteLength > ATTACHMENT_MAX_BYTES) continue;
    const name = sanitizeAttachmentName(a.filename, i);
    const key = `inbound-attachments/${groupId}/${i}-${name}`;
    try {
      await bucket.put(key, bytes, {
        httpMetadata: { contentType: a.mimeType || "application/octet-stream" },
      });
      refs.push({
        key,
        name,
        mimeType: a.mimeType || "application/octet-stream",
        size: bytes.byteLength,
      });
      stored++;
    } catch {
      // Best-effort: a failed put for one attachment must not block the
      // others or the ingestion flow. Skip and continue.
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Per-sender rate limit (KV-backed)
// ---------------------------------------------------------------------------

/**
 * Pure policy function: given a sender's lookup result (or null for
 * anonymous), return the per-day rate limit. Exported for unit tests.
 *
 * Unverified senders get the anonymous floor regardless of role.
 * Prevents a "create user with role=ADMIN, never verify, send spam at
 * admin allowance" exploit if user creation ever becomes self-serve
 * at scale.
 */
export function computeRateLimit(
  lookup: { role: string; emailVerified: Date | null } | null
): number {
  if (!lookup) return ANONYMOUS_LIMIT;
  if (!lookup.emailVerified) return ANONYMOUS_LIMIT;
  return ROLE_LIMITS[lookup.role] ?? ANONYMOUS_LIMIT;
}

/**
 * Resolve the per-day rate limit for a sender based on their user record.
 * Anonymous (no user row) and unverified senders get the ANONYMOUS_LIMIT
 * floor. Verified users get the limit for their role.
 *
 * Fail-safe: on any DB error, returns the anonymous floor rather than
 * granting capacity we can't verify. The send still proceeds (subject
 * to the floor); we just don't unlock the tiered allowance.
 *
 * The KV counter itself (`email-submit:<addr>`) is unchanged and remains
 * keyed by from-address, not by user — so the same anti-reflection
 * protection works whether or not the sender has an account.
 */
export async function resolveRateLimitForSender(db: D1Database, fromAddr: string): Promise<number> {
  try {
    const drizzleDb = getDb(db);
    const rows = await drizzleDb
      .select({ role: users.role, emailVerified: users.emailVerified })
      .from(users)
      .where(sql`LOWER(${users.email}) = LOWER(${fromAddr})`)
      .limit(1);
    return computeRateLimit(rows[0] ?? null);
  } catch {
    return ANONYMOUS_LIMIT;
  }
}

/**
 * Increment-and-check the KV-backed per-sender counter. The `limit`
 * parameter defaults to ANONYMOUS_LIMIT so callers can omit it for the
 * anti-reflection-only case; the email entrypoint passes a per-sender
 * limit resolved via resolveRateLimitForSender.
 */
export async function checkSenderRateLimit(
  kv: KVNamespace,
  fromAddr: string,
  limit: number = ANONYMOUS_LIMIT
): Promise<boolean> {
  const key = `email-submit:${fromAddr}`;
  const raw = await kv.get(key);
  const count = raw ? Number.parseInt(raw, 10) || 0 : 0;
  if (count >= limit) return false;
  await kv.put(key, String(count + 1), { expirationTtl: PER_SENDER_WINDOW_SEC });
  return true;
}

// ---------------------------------------------------------------------------
// Admin forward (best-effort; never throws into the handler)
// ---------------------------------------------------------------------------

async function forwardToAdminBestEffort(
  message: import("@cloudflare/workers-types").ForwardableEmailMessage,
  env: EmailHandlerEnv,
  reason: string,
  sessionId: string
): Promise<void> {
  if (!env.SUBMIT_ADMIN_FORWARD) {
    await logError(env.DB, {
      level: "warn",
      source: SOURCE,
      message: "SUBMIT_ADMIN_FORWARD env not set; dropping forward attempt",
      sessionId,
      context: { reason, from: message.from, to: message.to },
    });
    return;
  }
  try {
    await message.forward(env.SUBMIT_ADMIN_FORWARD);
  } catch (err) {
    await logError(env.DB, {
      source: SOURCE,
      message: "message.forward to admin failed",
      error: err,
      sessionId,
      context: {
        reason,
        destination: env.SUBMIT_ADMIN_FORWARD,
        from: message.from,
        to: message.to,
      },
    });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Classifier wiring (Phase C.1)
// ---------------------------------------------------------------------------

/** Per-routed-entry shape produced by computeRouting. One entry → one
 *  inbound_emails row + one workflow instance. Multi-intent rows produce
 *  N entries. */
interface RoutedEntry {
  intent: EmailIntent; // routed value written to inbound_emails.intent
  classifiedIntent: ClassifiedIntent | null;
  classifiedSubIntent: ClassifiedSubIntent;
  confidence: number | null;
  rationale: string;
  routingSource: string;
  flaggedForReview: boolean;
  refUrl: string | null;
}

interface RoutingDecision {
  routed: RoutedEntry[];
  classifierVersion: string | null;
  routingSource: string;
  aggregateConfidence: number | null;
  aggregateRationale: string;
  flaggedForReview: boolean;
  spamQuarantine: boolean;
  spamRationale: string;
}

/** Map a classifier intent to the routed `intent` column value used by
 *  the workflow's dispatch table. `new_event` keeps its name (rather
 *  than collapsing to legacy `submit`) so the multi-section receipt
 *  template can distinguish classifier-routed rows in the future; the
 *  workflow accepts both as the submit pipeline alias. */
function classifierToRoutedIntent(c: ClassifiedIntent): EmailIntent {
  return c;
}

/** Look up sender trust from inbound_email_senders (B6). Failure-safe:
 *  any error returns 'unknown'. */
async function lookupSenderTrust(db: D1Database, fromAddr: string): Promise<SenderTrustTier> {
  try {
    const dbi = getDb(db);
    const rows = await dbi
      .select({ status: inboundEmailSenders.trustStatus })
      .from(inboundEmailSenders)
      .where(eq(inboundEmailSenders.email, fromAddr))
      .limit(1);
    const status = rows[0]?.status;
    if (status === "trusted" || status === "watchlist" || status === "blocked") return status;
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** Drive the per-email routing decision. Single source of truth for the
 *  classifier ↔ address-fallback ↔ trusted-fastpath logic. Pure(ish) —
 *  reaches into env.AI for the classifier call but does not write to D1
 *  or touch the ForwardableEmailMessage. */
async function computeRouting(args: {
  env: EmailHandlerEnv;
  sessionId: string;
  addressIntent: EmailIntent;
  senderTrust: SenderTrustTier;
  /** WS3e — pass/fail/unknown verdict from the Authentication-Results header. */
  emailAuth: "pass" | "fail" | "unknown";
  toAddr: string;
  fromAddr: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  inReplyTo: string | null;
  references: string | null;
  attachmentCount: number;
  attachmentTypes: string[];
}): Promise<RoutingDecision> {
  const {
    env,
    sessionId,
    addressIntent,
    senderTrust,
    emailAuth,
    toAddr,
    fromAddr,
    subject,
    bodyText,
    bodyHtml,
    inReplyTo,
    references,
    attachmentCount,
    attachmentTypes,
  } = args;

  // Trusted-sender fast-path (spec §C.5): check cheap regex first.
  // Only short-circuit when sender is trusted AND no multi-intent /
  // correction / source-suggestion / claim / reply-chain signals fire.
  // WS3e — also require that the message didn't DEMONSTRABLY fail email auth
  // (SPF/DKIM/DMARC). On "fail" we skip the fast-path and fall through to the
  // full classifier, so a spoofed From of a trusted sender gets normal
  // scrutiny instead of a free pass. "unknown" still takes the fast-path.
  const replyChainHeader = isReplyToOurThread(inReplyTo, references);
  if (senderTrust === "trusted" && emailAuth !== "fail" && env.AI) {
    const fastpath = hasMultiIntentOrSpecialSignal({
      bodyText,
      bodyHtml,
      inReplyToHeader: inReplyTo,
      referencesHeader: references,
    });
    if (!fastpath.trigger) {
      return {
        routed: [
          {
            intent: addressIntent,
            classifiedIntent: null,
            classifiedSubIntent: null,
            confidence: null,
            rationale: `trusted-fastpath: ${fastpath.reason}`,
            routingSource: "trusted_fastpath",
            flaggedForReview: false,
            refUrl: null,
          },
        ],
        classifierVersion: null,
        routingSource: "trusted_fastpath",
        aggregateConfidence: null,
        aggregateRationale: `trusted-fastpath: ${fastpath.reason}`,
        flaggedForReview: false,
        spamQuarantine: false,
        spamRationale: "",
      };
    }
  }

  // No AI binding configured — pre-classifier behavior. Routes by
  // address only.
  if (!env.AI) {
    return {
      routed: [
        {
          intent: addressIntent,
          classifiedIntent: null,
          classifiedSubIntent: null,
          confidence: null,
          rationale: "no-ai-binding",
          routingSource: "address_only",
          flaggedForReview: false,
          refUrl: null,
        },
      ],
      classifierVersion: null,
      routingSource: "address_only",
      aggregateConfidence: null,
      aggregateRationale: "no-ai-binding",
      flaggedForReview: false,
      spamQuarantine: false,
      spamRationale: "",
    };
  }

  // Run the classifier. classifyIntent is fail-safe — never throws —
  // returns an `unclear` result on any error so this path can't bounce
  // the email.
  const result = await classifyIntent(env.AI, {
    toAddress: toAddr,
    fromAddress: fromAddr,
    senderTrustTier: senderTrust,
    isReplyToOurThread: replyChainHeader,
    attachmentCount,
    attachmentTypes,
    subject,
    bodyText,
  });

  await logError(env.DB, {
    level: "info",
    source: SOURCE,
    message: "classifier result",
    sessionId,
    context: {
      from: fromAddr,
      to: toAddr,
      addressIntent,
      classifierIntents: result.intents.map((c) => ({
        intent: c.intent,
        subIntent: c.subIntent,
        confidence: c.confidence,
      })),
      version: result.version,
      fromAi: result.fromAi,
      durationMs: result.finishedAt - result.startedAt,
    },
  });

  // Spam quarantine — applies BEFORE confidence-gate fallback because
  // we'd rather not auto-reply / forward when classifier is highly
  // confident this is junk. Use the top result only for this check.
  const top = result.intents[0];
  if (top.intent === "spam" && top.confidence >= SPAM_QUARANTINE_THRESHOLD && result.fromAi) {
    return {
      routed: [],
      classifierVersion: result.version,
      routingSource: "classifier",
      aggregateConfidence: top.confidence,
      aggregateRationale: top.rationale,
      flaggedForReview: false,
      spamQuarantine: true,
      spamRationale: top.rationale,
    };
  }

  // Multi-intent split: classifier returned 2+ children, all with
  // confidence ≥ threshold. Build N RoutedEntry's.
  if (result.intents.length >= 2 && result.fromAi) {
    const children = result.intents
      .filter((c) => c.confidence >= DEFAULT_CONFIDENCE_THRESHOLD)
      .slice(0, 4); // Spec §C.5 cap (also enforced upstream)
    if (children.length >= 2) {
      const routed = children.map((c) => buildRoutedEntry(c, addressIntent, "classifier_override"));
      const minConf = Math.min(...children.map((c) => c.confidence));
      return {
        routed,
        classifierVersion: result.version,
        routingSource: "classifier_override",
        aggregateConfidence: minConf,
        aggregateRationale: `multi-intent: ${children.length} children`,
        flaggedForReview: false,
        spamQuarantine: false,
        spamRationale: "",
      };
    }
    // Multi-intent but only one child crossed threshold — fall through
    // and treat the top child as single-intent below.
  }

  // Single-intent path.
  if (result.fromAi && top.confidence >= DEFAULT_CONFIDENCE_THRESHOLD) {
    const routedIntent = classifierToRoutedIntent(top.intent);
    const source =
      routedIntent === addressIntent || (routedIntent === "new_event" && addressIntent === "submit")
        ? "classifier"
        : "classifier_override";
    return {
      routed: [buildRoutedEntry(top, addressIntent, source)],
      classifierVersion: result.version,
      routingSource: source,
      aggregateConfidence: top.confidence,
      aggregateRationale: top.rationale,
      flaggedForReview: false,
      spamQuarantine: false,
      spamRationale: "",
    };
  }

  // Confidence below threshold OR classifier errored — fall back to
  // address-based routing + flag for admin review.
  return {
    routed: [
      {
        intent: addressIntent,
        classifiedIntent: top.intent,
        classifiedSubIntent: top.subIntent,
        confidence: top.confidence,
        rationale: top.rationale,
        routingSource: result.fromAi ? "fallback_low_confidence" : "address_only",
        flaggedForReview: true,
        refUrl: top.refUrl ?? null,
      },
    ],
    classifierVersion: result.version,
    routingSource: result.fromAi ? "fallback_low_confidence" : "address_only",
    aggregateConfidence: top.confidence,
    aggregateRationale: top.rationale,
    flaggedForReview: true,
    spamQuarantine: false,
    spamRationale: "",
  };
}

function buildRoutedEntry(
  c: IntentClassification,
  addressIntent: EmailIntent,
  routingSource: string
): RoutedEntry {
  // Map new_event → routes through the submit pipeline; keep classifier
  // value distinct so the audit trail preserves intent.
  const routedIntent = classifierToRoutedIntent(c.intent);
  const overrode = routedIntent !== addressIntent && routedIntent !== "submit";
  return {
    intent: routedIntent,
    classifiedIntent: c.intent,
    classifiedSubIntent: c.subIntent,
    confidence: c.confidence,
    rationale: c.rationale,
    routingSource: overrode ? routingSource : "classifier",
    flaggedForReview: false,
    refUrl: c.refUrl ?? null,
  };
}

/** Persist the audit row for a spam-quarantined message. Mirrors the
 *  normal INSERT path but writes intent='spam', skips forward, skips
 *  workflow create. */
async function insertSpamAuditRow(args: {
  env: EmailHandlerEnv;
  sessionId: string;
  fromAddr: string;
  toAddr: string;
  subject: string;
  bodyTextExcerpt: string;
  message: import("@cloudflare/workers-types").ForwardableEmailMessage;
  parsed: Email;
  attachmentCount: number;
  routing: RoutingDecision;
}): Promise<void> {
  const {
    env,
    sessionId,
    fromAddr,
    toAddr,
    subject,
    bodyTextExcerpt,
    message,
    parsed,
    attachmentCount,
    routing,
  } = args;
  const now = new Date();
  const messageId = (parsed.messageId || "").trim() || null;
  try {
    const db = getDb(env.DB);
    await db
      .insert(inboundEmails)
      .values({
        id: crypto.randomUUID(),
        receivedAt: now,
        fromAddress: fromAddr,
        toAddress: toAddr,
        subject: subject || null,
        intent: "spam",
        status: "forwarded",
        workflowInstanceId: null,
        bodyTextExcerpt: bodyTextExcerpt || null,
        parsedUrl: null,
        attachmentCount,
        rawSize: message.rawSize,
        error: null,
        messageId,
        classifiedIntent: "spam",
        classifiedSubIntent: null,
        classifiedConfidence: routing.aggregateConfidence,
        classifiedRationale: routing.spamRationale,
        classifiedAt: now,
        classifierVersion: routing.classifierVersion,
        routingSource: "classifier",
        routedToWorkflow: null,
        flaggedForReview: 0,
        parentEmailId: null,
        createdAt: now,
      })
      .onConflictDoNothing();
  } catch (err) {
    await logError(env.DB, {
      source: SOURCE,
      message: "failed to insert spam-quarantine audit row",
      error: err,
      sessionId,
      context: { from: fromAddr, to: toAddr, subject },
    });
  }
}

/**
 * OPE-74 — persist the TERMINAL audit-noop row for a never-actionable
 * audit/system sender. Deliberately mirrors insertSpamAuditRow's shape (single
 * INSERT, message_id dedup via onConflictDoNothing, no forward, no workflow
 * create) but writes:
 *   - status='audit-noop'      — a terminal state no queue counts
 *   - intent='audit-noop'      — never a salvage/waiting intent
 *   - flagged_for_review=0     — never surfaced for human review
 *   - extract_fail_reason=reason (the categorical audit tag)
 *   - all classifier columns NULL (proves the row bypassed classification)
 *
 * Takes an already-wrapped Drizzle Db so it's directly unit-testable against a
 * throwaway SQLite (same convention as reconcileInboundExceptions). Throws on a
 * DB error; the caller wraps it best-effort so ingestion never breaks. Exported
 * for unit tests.
 */
export async function insertAuditNoopRow(
  db: Db,
  args: {
    fromAddr: string;
    toAddr: string;
    subject: string;
    bodyTextExcerpt: string;
    attachmentCount: number;
    rawSize: number | null;
    messageId: string | null;
    reason: string;
    now?: Date;
  }
): Promise<void> {
  const now = args.now ?? new Date();
  await db
    .insert(inboundEmails)
    .values({
      id: crypto.randomUUID(),
      receivedAt: now,
      fromAddress: args.fromAddr,
      toAddress: args.toAddr,
      subject: args.subject || null,
      intent: "audit-noop",
      status: "audit-noop",
      workflowInstanceId: null,
      bodyTextExcerpt: args.bodyTextExcerpt || null,
      parsedUrl: null,
      attachmentCount: args.attachmentCount,
      rawSize: args.rawSize,
      error: null,
      messageId: args.messageId,
      classifiedIntent: null,
      classifiedSubIntent: null,
      classifiedConfidence: null,
      classifiedRationale: null,
      classifiedAt: null,
      classifierVersion: null,
      routingSource: "audit_noop_sender",
      routedToWorkflow: null,
      flaggedForReview: 0,
      extractFailReason: args.reason,
      parentEmailId: null,
      createdAt: now,
    })
    .onConflictDoNothing();
}

// Silence "imported but unused" for CLASSIFIER_VERSION — it's available
// for callers that want to log the version separately.
void CLASSIFIER_VERSION;
