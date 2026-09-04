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
import { stripQuotedReply } from "./email-handlers/strip-quoted-reply.js";
import { getDb, type Db } from "./db.js";
import { inboundEmails, inboundEmailSenders, users, adminActions } from "./schema.js";
import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  participantKey,
  parseMessageIdList,
  normalizeThreadSubject,
  resolveThread,
  type ThreadBasis,
} from "@takemetothefair/utils";
import {
  isPhotoOnlySubmission,
  resolveIntent,
  shouldForwardToAdmin,
  type EmailIntent,
} from "./email-intents.js";
import { mainAppFetch, type MainAppEnv } from "./main-app-fetch.js";
import { routeToProject } from "./inbound/project-router.js";
import { handleNewsletterSubscribeEmail } from "./email-handlers/newsletter-subscribe.js";
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
import {
  detectEventTriple,
  shouldRecoverSpamRow,
  type TripleResult,
} from "./email-handlers/spam-event-triple.js";
import { hasMultiIntentOrSpecialSignal, isReplyToOurThread } from "./intent-fastpath.js";
import { isDenylistedHost } from "./url-denylist.js";
import { resolveSenderIdentity } from "./inbound/resolve-sender-identity.js";
import {
  parseEmailAuth,
  parseEmailAuthDetail,
  type EmailAuthVerdict,
  type SenderAuthVerdict,
} from "./email-auth.js";
import { isNonActionableSender } from "./email-handlers/audit-sender.js";

// ---------------------------------------------------------------------------
// Env shape required by this module
// ---------------------------------------------------------------------------
export interface EmailHandlerEnv {
  /** D1 binding — `inbound_emails` persistence + error_logs. */
  DB: D1Database;
  /**
   * OPE-803 — `"true"` routes a quarantined-spam row that names a specific
   * event to admin triage instead of terminating it.
   *
   * ⚠️ Ships **"false"**. Detection runs and is recorded either way; only the
   * routing change is gated. The STOP-gate on the ticket is explicit that the
   * recovery path must not go live until John has seen a dry-run — and it is
   * a plaintext `[vars]` entry, so it must be flipped in
   * `mcp-server/wrangler.toml` and deployed. A dashboard edit is reverted by
   * the next `wrangler deploy`, which replaces the whole block from the
   * committed file.
   */
  SPAM_EVENT_RECOVERY_ENABLED?: string;
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
  INBOUND_EMAIL: Workflow<{
    messageRowId: string;
    intent: EmailIntent;
    // OPE-202 — threaded to the per-intent handler via HandlerCtx.
    senderTrust?: SenderTrustTier;
    emailAuth?: EmailAuthVerdict;
  }>;
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
// OPE-156 — cap on the full HTML body persisted to inbound_emails.body_html so
// a pathological newsletter can't approach D1's 2 MB row limit. Real inbound
// mail (raw ≤ ~70 KB incl. attachments) is far under this; the plain-text body
// is already bounded by MAX_BODY_LEN.
const BODY_STORE_MAX = 500_000;
const SOURCE = "mcp:email-handler";

// OPE-68 attachment-capture caps. Per-attachment size ceiling (skip larger)
// and a total-count ceiling (only the first N image/PDF attachments) so a
// pathological many-attachment message can't blow the receive-time budget.
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB per attachment
const ATTACHMENT_MAX_COUNT = 5; // payload image/PDF attachments per email
/**
 * OPE-760 — separate, smaller quota for signature furniture.
 *
 * Furniture no longer competes with real files for the main cap. It keeps a
 * small allowance of its own so an admin viewing the message still sees the
 * sender's branding, without six social icons costing a poster its slot.
 *
 * ⚠️ NOT shared with OPE-459's URL cap. That was worth checking and the answer
 * is no: this file's `ATTACHMENT_MAX_COUNT` is the only definition, and the
 * URL-side cap OPE-459 describes lives elsewhere. Two coincidental fives, not
 * one constant — so fixing this one does not fix that one.
 */
const ATTACHMENT_MAX_FURNITURE = 2;

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
    // OPE-156 — full body persisted for the admin viewer (list preview stays
    // the excerpt). null-coalesced to keep empty parts out of the row.
    const bodyTextStored = bodyText || null;
    const bodyHtmlStored = bodyHtml ? bodyHtml.slice(0, BODY_STORE_MAX) : null;
    const attachmentCount = parsed.attachments?.length ?? 0;
    // OPE-763 — computed once here, spread into every insert below.
    const senderSignals = extractSenderSignals(message.headers, parsed);
    // OPE-764 — likewise. Fail-soft: never takes a message down.
    const senderIdentity = await resolveSenderColumns(env, sessionId, fromAddr, bodyText);
    // OPE-768 — likewise: computed once, spread into every insert below.
    const threadColumns = await resolveThreadColumns(env, sessionId, {
      fromAddr,
      toAddr,
      subject,
      inReplyTo: parsed.inReplyTo ?? null,
      emailReferences: parsed.references ?? null,
    });

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
          bodyTextStored,
          bodyHtmlStored,
          senderSignals,
          senderIdentity,
          threadColumns,
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

    // 3. OPE-327 (D-1) — route to a PROJECT first, then to that project's
    //    intent classifier.
    //
    //    Today MMATF is the only tenant with live inbound, so its mail routes
    //    exactly as before and `resolveIntent` is unchanged — the regression
    //    clause. What changes is that the assumption "every email is MMATF's"
    //    is now written down and checked instead of implicit, so a second
    //    project's mail can never be silently handled by MMATF's classifier.
    //
    //    UNROUTED is deliberately not a failure: it falls through to the same
    //    `unknown` intent that already forwards to admin, so nothing is
    //    dropped. Turning UNROUTED into a hold-and-ask reply is the next
    //    increment; making the verdict VISIBLE is what this one buys.
    // NB: named projectRouting, not routing — `routing` is already the
    // intent-routing decision computed further down, and shadowing it here
    // silently broke that call site until tsc caught it.
    const projectRouting = routeToProject({
      toAddress: toAddr,
      fromAddress: fromAddr,
      subject,
    });
    await logError(env.DB, {
      level: "info",
      source: "email-handler:ope-327-router",
      message: `project routing: ${projectRouting.project} — ${projectRouting.reason}`,
      sessionId,
      context: { to: toAddr, project: projectRouting.project, basis: projectRouting.basis },
    });

    //    Resolve address-based intent (always computed — used as
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

    // 3b-iii. OPE-315 — a photo-only mail is a photo submission whatever
    //     address it arrived at. John mailed two booth photos to submit@ with
    //     no body; the event-extraction lane tried to read prose that wasn't
    //     there, failed `no-url-prose-failed`, and replied "couldn't pull out
    //     key fields", while the photo-intake lane sat unused because it is
    //     keyed to photos@. Content shape beats recipient address here.
    //
    //     Gated on a trusted sender, per the ticket: photo intake writes to R2
    //     and can attach vendor evidence, so an untrusted stranger must not be
    //     able to reach it by sending an attachment to a public address. An
    //     untrusted photo-only mail keeps its address-based intent exactly as
    //     before.
    let effectiveAddressIntent = addressIntent;
    if (
      addressIntent !== "photo_intake" &&
      senderTrust === "trusted" &&
      isPhotoOnlySubmission({ attachments: parsed.attachments, bodyText })
    ) {
      effectiveAddressIntent = "photo_intake";
      await logError(env.DB, {
        level: "info",
        source: "email-handler:ope-315-photo-only",
        message: `photo-only mail to ${toAddr} rerouted from ${addressIntent} to photo_intake`,
        sessionId,
        context: { from: fromAddr, to: toAddr, addressIntent, attachmentCount },
      });
    }
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

    // 3b-iv. OPE-311 (audit A1) — auto-ingest GSC click-milestone mail.
    //
    //     Google sends "Congrats on reaching NK clicks in 28 days" from
    //     sc-noreply@google.com. Those carry the only record we get of a
    //     milestone date, and until now each one was hand-entered as SQL (the
    //     7K milestone was ingested by hand at the retro). Forwarded copies
    //     arrive from a human address, so the subject shape is checked too.
    //
    //     The main-app endpoint owns the parse AND the idempotent upsert, so
    //     this deliberately does NOT re-implement the subject regex here — it
    //     hands over the raw subject/body and lets the single parser decide.
    //     A non-milestone subject is simply parsed to null and ignored, which
    //     is why ordinary sc-noreply mail still routes normally.
    //
    //     Fail-soft throughout: a milestone chart is not worth dropping an
    //     inbound email over, so any error is logged and ingestion continues.
    if (looksLikeGscMilestone(fromAddr, subject)) {
      try {
        const res = await mainAppFetch(
          env as unknown as MainAppEnv,
          "/api/admin/analytics/gsc-milestone-ingest",
          "fetch",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              subject,
              body: bodyText,
              email_date: new Date().toISOString(),
              note: `auto-ingested from inbound email (OPE-311), from=${fromAddr}`,
            }),
          }
        );
        await logError(env.DB, {
          level: res.ok ? "info" : "warn",
          source: "email-handler:ope-311-gsc-milestone",
          message: res.ok
            ? `GSC milestone email auto-ingested (status ${res.status})`
            : `GSC milestone auto-ingest returned ${res.status}`,
          sessionId,
          context: { from: fromAddr, subject },
        });

        // OPE-456 scope 1a — a successfully-ingested milestone is TERMINAL.
        //
        // This block already ran and then fell through to the classifier and
        // the submission workflow. One email, two consumers, one of them wrong:
        // the 12K milestone ingested correctly AND the submission lane answered
        // Google Search Console that it forgot to include a link to its event.
        //
        // Terminating here rather than adding a `gsc_milestone` intent to the
        // classifier taxonomy. The taxonomy has many consumers and widening it
        // is a change with reach; this email has no remaining work once the
        // milestone is stored, which is exactly the shape `subscribe@` already
        // uses two blocks below ("handled entirely here... nothing for the
        // classifier or the workflow to do").
        //
        // Gated on `res.ok`, and that is load-bearing: the endpoint returns
        // **400 not_a_milestone** when the subject matches neither shape, so an
        // ordinary sc-noreply email still routes normally. Terminating on the
        // pre-filter alone would swallow real mail.
        if (res.ok) {
          try {
            await insertAuditNoopRow(getDb(env.DB), {
              fromAddr,
              toAddr,
              subject,
              bodyTextExcerpt,
              bodyTextStored,
              bodyHtmlStored,
              senderSignals,
              senderIdentity,
              threadColumns,
              attachmentCount,
              rawSize: message.rawSize,
              messageId: (parsed.messageId || "").trim() || null,
              reason: "gsc-milestone-ingested",
            });
          } catch (err) {
            await logError(env.DB, {
              source: "email-handler:ope-311-gsc-milestone",
              message: "failed to record terminal row for ingested GSC milestone",
              error: err,
              sessionId,
              context: { from: fromAddr, subject },
            }).catch(() => {});
          }
          await logError(env.DB, {
            level: "info",
            source: "email-handler:ope-311-gsc-milestone",
            message:
              "GSC milestone ingested; skipped classifier + submission workflow (OPE-456 scope 1a)",
            sessionId,
            context: { from: fromAddr, subject },
          }).catch(() => {});
          return;
        }
      } catch (e) {
        await logError(env.DB, {
          level: "warn",
          source: "email-handler:ope-311-gsc-milestone",
          message: "GSC milestone auto-ingest failed (email still processed normally)",
          error: e,
          sessionId,
          context: { from: fromAddr, subject },
        });
      }
    }

    // 3b-v. OPE-317 — subscribe@ is handled entirely here. The sender gets the
    //     normal confirmation email from the main app's subscribe endpoint, so
    //     there is nothing for the classifier or the workflow to do, and
    //     nothing to forward to admin (shouldForwardToAdmin excludes it).
    //     Failsoft: a subscribe that doesn't reach the endpoint is logged and
    //     the email still records normally, rather than throwing away the row.
    if (effectiveAddressIntent === "newsletter_subscribe") {
      await handleNewsletterSubscribeEmail(
        env as unknown as MainAppEnv & { DB: D1Database },
        fromAddr
      );
    }

    // 3c. Compute the routing decision: maybe run the classifier, maybe
    //     short-circuit via the trusted-sender fast-path, always end
    //     with a `routed` array of {intent, ...} for the INSERT loop.
    const routing = await computeRouting({
      env,
      sessionId,
      addressIntent: effectiveAddressIntent,
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
      const spamRowId = await insertSpamAuditRow(getDb(env.DB), {
        env,
        sessionId,
        fromAddr,
        toAddr,
        subject,
        bodyTextExcerpt,
        bodyTextStored,
        bodyHtmlStored,
        senderSignals,
        senderIdentity,
        threadColumns,
        message,
        parsed,
        attachmentCount,
        routing,
      });
      // OPE-803 — record what the triple detector saw on this quarantined row.
      //
      // This runs while `SPAM_EVENT_RECOVERY_ENABLED` is "false", and that is
      // the point: a flag shipped dark with no telemetry gives John nothing to
      // decide on, and "we built it and turned it off" is indistinguishable
      // from "we built it and it never ran". These rows ARE the dry-run.
      //
      // Only the quarantine path needs this. A RECOVERED row marks itself —
      // `flagged_for_review = 1` and `routing_source = 'spam_event_recovery'`
      // sit on the inbound row — whereas a quarantined row leaves no trace at
      // all, which is the condition this ticket was filed about.
      //
      // Misses are recorded too, carrying `read`/`truncated`, because a miss on
      // a 500-char excerpt means "the body was discarded before OPE-762 landed
      // on 2026-09-02", not "there was no event in it".
      if (routing.eventTriple && spamRowId) {
        await recordSpamTripleObservation(getDb(env.DB), {
          inboundEmailId: spamRowId,
          triple: routing.eventTriple,
        });
      }
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
    // OPE-452 — pick the URL from the sender's NEW text, not from the quoted
    // copy of our own outbound reply beneath it.
    //
    // Emma Welford's reply carried three organizer-confirmed dates and no URL
    // whatsoever, yet the row recorded
    // `https://meetmeatthefair.com/promoters/paradise-city-arts-festivals` —
    // a link that appears only inside the quote of what WE sent her. On any
    // reply, the more helpful our original message was, the more of our own
    // links there are to misattribute to the person answering us.
    //
    // Falls back to the full body when there is no quoted region, when the
    // quote belongs to a FORWARD (there the quoted text is the submission), or
    // when the sender bottom-posted — see stripQuotedReply.
    const newText = stripQuotedReply(bodyText);
    const quotedReplyStripped = newText !== bodyText;
    // When a quoted reply was removed, the HTML alternative still contains that
    // same quote and cannot be stripped as cheaply — so it is not consulted.
    // The honest result for a reply whose new text carries no link is NO url,
    // which is exactly Emma's case: she sent three dates and zero URLs.
    const parsedUrl = pickPrimaryUrl(newText, quotedReplyStripped ? "" : bodyHtml);

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
    let attachmentSkipsJson: string | null = null;
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
        const { refs, skipped } = await captureAttachments(
          env.VENDOR_ASSETS,
          groupId,
          parsed.attachments
        );
        if (refs.length > 0) attachmentRefsJson = JSON.stringify(refs);
        if (skipped.length > 0) attachmentSkipsJson = JSON.stringify(skipped);

        // OPE-467 — the invariant. Every attachment we were handed is either
        // stored or explained; anything else means a part went missing between
        // `attachment_count` and both records, which is a genuine capture fault
        // rather than a policy decision.
        //
        // Warn-only by design. The alternative is failing ingestion over an
        // accounting discrepancy, which would throw away the email as well as
        // the attachment. `[[feedback_suppressing_alert_does_not_fix_state]]`
        // cuts the other way here: the state IS recorded now (in
        // attachment_skips), so this line is the alert, not a substitute for a
        // fix. The OPE-464 `extract.attachment_lost` emitter reads this shape.
        const accountedFor = refs.length + skipped.length;
        if (accountedFor !== attachmentCount) {
          await logError(env.DB, {
            level: "warn",
            source: SOURCE,
            message: `attachment accounting mismatch: claimed ${attachmentCount}, stored ${refs.length}, skipped ${skipped.length}`,
            sessionId,
            context: {
              from: fromAddr,
              to: toAddr,
              attachmentCount,
              stored: refs.length,
              skipped: skipped.length,
              faultSignature: `extract.attachment_lost:${attachmentCount - accountedFor}`,
            },
          }).catch(() => {});
        }
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
            bodyText: bodyTextStored,
            bodyHtml: bodyHtmlStored,
            // OPE-763 / OPE-764 — report-only capture; nothing branches on these.
            ...senderSignals,
            ...senderIdentity,
            ...threadColumns,
            parsedUrl,
            attachmentCount,
            attachmentRefs: attachmentRefsJson,
            attachmentSkips: attachmentSkipsJson,
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
            // OPE-254 — persist threading headers so a handler can match a
            // reply back to the inbound it answers (e.g. photo-intake resolve).
            inReplyTo: parsed.inReplyTo ?? null,
            emailReferences: parsed.references ?? null,
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
            bodyText: bodyTextStored,
            bodyHtml: bodyHtmlStored,
            // OPE-763 / OPE-764 — report-only capture; nothing branches on these.
            ...senderSignals,
            ...senderIdentity,
            ...threadColumns,
            parsedUrl: r.refUrl ?? parsedUrl,
            attachmentCount,
            attachmentRefs: attachmentRefsJson,
            attachmentSkips: attachmentSkipsJson,
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
            // OPE-254 — see multi-parent insert above. The correction reply
            // that names a held photo's fair lands here (single-intent path).
            inReplyTo: parsed.inReplyTo ?? null,
            emailReferences: parsed.references ?? null,
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
          // OPE-202 — thread the sender trust tier + email-auth verdict computed
          // above so the per-intent handler (e.g. photo_intake) can gate on
          // "authenticated + trusted" without re-deriving.
          params: { messageRowId: rowId, intent: r.intent, senderTrust, emailAuth },
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
    // OPE-459 — a dotless host is not a reachable public URL, and in practice
    // means the string was cut off mid-host. `https://gomarthasvineyard.com/…`
    // truncated at a body-length boundary becomes `https://go`, which `new URL`
    // parses perfectly happily as host `go` — so a real regional events
    // calendar was replaced by a fetch of `https://go/` that could only ever
    // fail, and did, silently.
    //
    // The root cause was fixed upstream (the caller now reads the full body,
    // not the 500-char preview). This stays as the cheap general guard: any
    // future truncation, anywhere, is rejected here rather than turned into a
    // plausible-looking request. `localhost` and intranet hosts are not valid
    // submission sources either, so nothing legitimate is lost.
    if (!p.hostname.includes(".")) return null;
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
  /**
   * OPE-760 — the signals that make the cap content-aware.
   *
   * These were the actual defect. PostalMime supplies `contentId`,
   * `disposition` and `related` on every attachment, and this interface threw
   * all three away — so `captureAttachments` COULD NOT tell a 600-byte
   * LinkedIn icon from a 900 KB poster even in principle, and fell back to
   * arrival order. The cap was not content-blind by choice; it was blind
   * because the type it operates on is.
   *
   * Optional so existing callers keep compiling; absent simply means "no
   * signal", which classifies as payload — the safe direction, since a
   * misclassified payload is merely stored, while a misclassified poster is
   * lost.
   */
  contentId?: string;
  disposition?: "attachment" | "inline" | null;
  related?: boolean;
}

/**
 * Largest an inline, `cid:`-referenced image can be and still be assumed to be
 * signature furniture rather than a payload.
 *
 * 64 KB. The observed specimen (inbound `ce16f4a1`, jeremy.hall@ct.gov) is the
 * calibration: four social icons at 498–713 B, a LinkedIn icon at 1,083 B, and
 * a CT DEEP logo at 24,897 B — all six `cid:`-referenced Outlook signature
 * graphics. 64 KB clears the logo with room to spare.
 *
 * Deliberately generous, and the asymmetry is why: a poster misread as
 * furniture is only DEPRIORITISED, never discarded, because furniture has its
 * own quota below. A payload misread the other way costs a slot. So the
 * threshold errs toward calling small inline images furniture.
 */
const SIGNATURE_MAX_BYTES = 64 * 1024;

/**
 * Is this attachment signature furniture rather than something the sender
 * meant to send us?
 *
 * Two signals, BOTH required: it is referenced from the body (`cid:` /
 * `inline` / `related`) AND it is small. Either alone is wrong — a fair
 * routinely embeds its poster inline, and plenty of real files are small.
 *
 * Pure, and exported, so the classification can be tested against the real
 * specimen without a mailbox.
 */
export function isSignatureFurniture(
  a: Pick<CapturableAttachment, "mimeType" | "contentId" | "disposition" | "related">,
  sizeBytes: number
): boolean {
  const mime = (a.mimeType || "").toLowerCase();
  // A PDF is never signature furniture, whatever its disposition says.
  if (!mime.startsWith("image/")) return false;
  const embedded = !!a.contentId || a.disposition === "inline" || a.related === true;
  return embedded && sizeBytes > 0 && sizeBytes <= SIGNATURE_MAX_BYTES;
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
 * Why an attachment we were handed did not end up in R2.
 *
 * OPE-467 — every one of these was previously a bare `continue`. The filters
 * are mostly CORRECT (we do not want a 40 MB .mov or a signature GIF), but an
 * unrecorded filter is indistinguishable from a bug: the defect sat live for
 * three months and was found by hand-diffing `attachment_count` against
 * `attachment_refs`.
 */
export type AttachmentSkipReason =
  /** Past ATTACHMENT_MAX_COUNT. The sender's later attachments are simply gone. */
  | "over-count-cap"
  /** Not image/* or application/pdf — a .docx roster, a calendar invite, a .eml. */
  | "unsupported-type"
  /** Over ATTACHMENT_MAX_BYTES. */
  | "too-large"
  /** Zero-length or undecodable content. */
  | "empty"
  /** The R2 put threw. The only reason here that is unambiguously a fault. */
  | "put-failed";

export interface AttachmentSkip {
  /** Position in the ORIGINAL attachment list, so a skip can be lined up
   *  against the stored keys (which embed the same index). */
  index: number;
  name: string;
  mimeType: string;
  size: number;
  reason: AttachmentSkipReason;
  /**
   * OPE-760 — was this skip signature furniture rather than something the
   * sender meant to send?
   *
   * Recorded at capture time rather than re-derived later, because the signals
   * that decide it (`contentId`, `disposition`, `related`) exist only on the
   * live MIME part and are gone by the time anything reads this column.
   *
   * It exists so a monitor can be silent about the ordinary case. With a
   * furniture quota of 2, a six-icon Outlook signature now skips four icons on
   * EVERY message from that sender — an alert that reported those would be
   * pure wallpaper within a week, and the one real dropped file would arrive
   * in a stream nobody reads. Absent means "classified before this field
   * existed", which is not the same as `false`.
   */
  furniture?: boolean;
}

export interface AttachmentCapture {
  refs: AttachmentRef[];
  skipped: AttachmentSkip[];
}

/**
 * Persist inbound image/PDF attachments to R2 and report what happened to
 * every one of them.
 *
 * Purely best-effort: every R2 put is individually try/caught so a single
 * failed attachment doesn't abort the rest, and a missing bucket binding
 * (tests / non-R2 envs) short-circuits. Callers wrap the whole thing in their
 * own try/catch too — this helper never throws.
 *
 * Only `image/*` and `application/pdf` attachments are stored, within a
 * per-attachment size cap (ATTACHMENT_MAX_BYTES) and a total-count cap
 * (ATTACHMENT_MAX_COUNT).
 *
 * ── OPE-467: it returns the skips, and that is the point ─────────────────
 *
 * The filters did not change. What changed is that they now say so. The
 * function's contract is that `refs.length + skipped.length` equals the number
 * of attachments handed in — so "we kept fewer than arrived" becomes a
 * checkable statement instead of a subtraction somebody has to think to do.
 *
 * Returning a bare `AttachmentRef[]` was the actual defect: it made discarding
 * the disposition the path of least resistance, which is exactly what every
 * caller did. Hence no convenience overload that throws the skips away.
 *
 * Exported for unit tests.
 */
export async function captureAttachments(
  bucket: R2Bucket | undefined,
  groupId: string,
  attachments: CapturableAttachment[] | undefined
): Promise<AttachmentCapture> {
  const refs: AttachmentRef[] = [];
  const skipped: AttachmentSkip[] = [];
  if (!attachments || attachments.length === 0) return { refs, skipped };

  // ── OPE-760: classify and RANK before the cap applies ───────────────────
  //
  // The cap used to fill in arrival order, so six Outlook signature icons
  // could exhaust it before the sender's actual poster was reached. Observed
  // on inbound `ce16f4a1` (jeremy.hall@ct.gov): five icons stored, the sixth
  // skipped `over-count-cap`, and every one of them decorative.
  //
  // Nothing of value was lost that time. The defect is that nothing about the
  // mechanism made that luck rather than design — any correspondent on a
  // corporate mail system with a branded signature hits it, which is most
  // organizers, chambers and agencies.
  //
  // Ordering, not filtering: furniture keeps its own quota and its own place in
  // the list, so a MISCLASSIFIED payload is merely later, never dropped. The
  // original arrival index travels with every ref and skip, so this reorder is
  // invisible to anything that keyed on it.
  const ordered = attachments
    .map((a, index) => {
      const bytes = attachmentBytes(a.content);
      const size = bytes?.byteLength ?? 0;
      return { a, index, bytes, size, furniture: isSignatureFurniture(a, size) };
    })
    .sort((x, y) => {
      // Payload before furniture; then largest first, because between two
      // genuine attachments the bigger one is likelier to be the poster or the
      // roster rather than a second logo.
      if (x.furniture !== y.furniture) return x.furniture ? 1 : -1;
      if (y.size !== x.size) return y.size - x.size;
      return x.index - y.index;
    });

  let stored = 0;
  let storedFurniture = 0;
  for (const item of ordered) {
    const { a, index: i, bytes } = item;
    const mimeType = a.mimeType || "application/octet-stream";
    const name = sanitizeAttachmentName(a.filename, i);
    const note = (reason: AttachmentSkipReason) =>
      skipped.push({
        index: i,
        name,
        mimeType,
        size: bytes?.byteLength ?? 0,
        reason,
        furniture: item.furniture,
      });

    // No bucket binding (tests / non-R2 envs): nothing can be stored, but the
    // sender still sent these, so they are reported rather than vanishing.
    if (!bucket) {
      note("put-failed");
      continue;
    }
    // ⚠️ ORDER MATTERS, and it changed with OPE-760's reorder.
    //
    // The count cap now runs LAST of the filters, after type / empty / size.
    // Before the reorder it ran first and got away with it, because arrival
    // order happened to put a non-media part ahead of the media that filled
    // the cap. Ranking by size broke that coincidence: a 10-byte .ics sorted
    // to the end and came back `over-count-cap` instead of `unsupported-type`,
    // which is a worse diagnosis of the same event — it blames a quota for a
    // part that could never have been stored under any quota.
    //
    // Only a thing we would otherwise KEEP may consume or be refused a slot.
    const mime = mimeType.toLowerCase();
    if (!mime.startsWith("image/") && mime !== "application/pdf") {
      note("unsupported-type");
      continue;
    }
    if (!bytes) {
      note("empty");
      continue;
    }
    if (bytes.byteLength > ATTACHMENT_MAX_BYTES) {
      note("too-large");
      continue;
    }
    // Two quotas, so furniture cannot consume a payload slot. This is the
    // whole fix: the acceptance case is "six icons plus one real poster stores
    // the poster", and it holds because the poster is not furniture and the
    // icons are not competing for its quota.
    if (
      item.furniture ? storedFurniture >= ATTACHMENT_MAX_FURNITURE : stored >= ATTACHMENT_MAX_COUNT
    ) {
      note("over-count-cap");
      continue;
    }
    const key = `inbound-attachments/${groupId}/${i}-${name}`;
    try {
      await bucket.put(key, bytes, { httpMetadata: { contentType: mimeType } });
      refs.push({ key, name, mimeType, size: bytes.byteLength });
      if (item.furniture) storedFurniture++;
      else stored++;
    } catch {
      // A failed put for one attachment must not block the others or the
      // ingestion flow — but it is now recorded rather than swallowed.
      note("put-failed");
    }
  }
  return { refs, skipped };
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
  /**
   * OPE-803 — what the event-triple detector found on a row the classifier
   * called spam. Populated whenever the quarantine branch is reached, hit or
   * miss, so the miss is recorded too: a miss read off a 500-char excerpt is
   * not the same fact as a miss read off a full body.
   */
  eventTriple?: TripleResult;
  /**
   * True when a triple hit AND `SPAM_EVENT_RECOVERY_ENABLED` is on, so the row
   * was routed for review instead of terminating. Deliberately distinct from
   * `eventTriple.hit`, which says what was FOUND regardless of the flag —
   * keeping them separate is what lets the dark period accumulate evidence.
   */
  tripleRecovered?: boolean;
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
    // OPE-803 — does this message name a specific event?
    //
    // John's framing: sender credibility and message value are independent
    // axes. The classifier's spam call is NOT revisited here and `top.intent`
    // stays `spam` on the stored row — a broker stays a broker. The only
    // question asked is whether the message names something checkable.
    //
    // The detector runs on EVERY quarantined row, hit or miss, and its result
    // is carried out on the decision so the caller can record it. That is
    // deliberate: during the dark period the misses are the evidence base for
    // whether the flag is worth flipping, and a miss read off a truncated
    // excerpt is a different fact from a miss read off a full body.
    const eventTriple = detectEventTriple({
      bodyText,
      bodyTextExcerpt: bodyText ? bodyText.slice(0, 500) : null,
      subject,
    });
    const recover = shouldRecoverSpamRow(eventTriple, env.SPAM_EVENT_RECOVERY_ENABLED);

    if (!recover) {
      return {
        routed: [],
        classifierVersion: result.version,
        routingSource: "classifier",
        aggregateConfidence: top.confidence,
        aggregateRationale: top.rationale,
        flaggedForReview: false,
        spamQuarantine: true,
        spamRationale: top.rationale,
        eventTriple,
      };
    }

    // Recovered. Route to `unknown` — the admin triage disposition — rather
    // than to any creating lane.
    //
    // ⚠️ `unknown` is chosen because it does not reply to the sender
    // (`fanout-reply-leader.ts:57-58`, from source). That property is
    // load-bearing, not incidental: answering an attendee-list broker is the
    // entire purpose of their send, because it confirms the address is live.
    // Nothing downstream of `unknown` creates an event either — creation
    // happens only through the independent-confirmation gate, never from the
    // message.
    return {
      // `classifiedIntent` is left as `spam` by passing `top` through
      // untouched — the classifier's call stays on the row, auditable, exactly
      // as the acceptance criteria require. Only the ROUTED intent changes,
      // to `unclear`, which the workflow dispatch table maps to
      // `handleUnknown`. `spam` has its own dedicated handler and routing
      // there would land straight back in the terminal state this recovers
      // from.
      routed: [
        {
          ...buildRoutedEntry(top, addressIntent, "spam_event_recovery"),
          intent: "unclear" as EmailIntent,
          routingSource: "spam_event_recovery",
          flaggedForReview: true,
        },
      ],
      classifierVersion: result.version,
      routingSource: "spam_event_recovery",
      aggregateConfidence: top.confidence,
      aggregateRationale: top.rationale,
      // Surfaced in the admin review queue — the whole point of recovering it.
      flaggedForReview: true,
      spamQuarantine: false,
      spamRationale: top.rationale,
      eventTriple,
      tripleRecovered: true,
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

/**
 * OPE-764 — the sender-identity columns, shaped for the insert.
 *
 * Same one-object-spread discipline as `SenderSignals`, and for the same
 * reason: four insert sites, and OPE-762 is the standing proof that hand-copied
 * fields diverge.
 */
export interface SenderIdentityColumns {
  matchedEntities: string | null;
  matchedEntityType: string | null;
  matchedEntityId: string | null;
  matchBasis: string;
  matchConfidence: number | null;
}

/** What we record when we looked and found nobody — distinct from NULL. */
export const NO_SENDER_MATCH: SenderIdentityColumns = {
  matchedEntities: "[]",
  matchedEntityType: null,
  matchedEntityId: null,
  matchBasis: "none",
  matchConfidence: null,
};

/**
 * Resolve the sender, FAIL-SOFT.
 *
 * This runs on the receive path, where the budget is tight and the stakes are
 * asymmetric: a missing identity costs an operator one lookup, and a thrown
 * exception costs the message. So every failure — a slow query, a schema
 * surprise, anything — degrades to `NO_SENDER_MATCH` and is logged, never
 * propagated.
 *
 * ⚠️ That means a total resolver outage looks exactly like "nobody matched",
 * which is the inert-guard problem. It is logged at `warn` with the sender, so
 * the difference is recoverable from `error_logs`; and `match_basis='none'`
 * with a NULL `matched_entities` would be the tell if it ever mattered, since
 * the success path always writes at least `[]`.
 */
/**
 * OPE-768 — assign the conversation this message belongs to.
 *
 * Spread into every insert below, exactly like `senderSignals` and
 * `senderIdentity`, because there are FOUR insert sites in this file and a
 * thread key applied to three of them would be worse than none: the queue would
 * count people correctly except on the paths nobody looks at.
 *
 * Fail-soft by the same contract as sender identity — threading is bookkeeping,
 * and it must never be the reason a real message fails to land. On error the
 * message still gets a thread: its own new one.
 */
interface ThreadColumns {
  threadId: string;
  threadPosition: number;
  threadBasis: ThreadBasis;
}

/** Recent rows scanned for the weak (subject+participants) tier. */
const THREAD_CANDIDATE_WINDOW = 60;

async function resolveThreadColumns(
  env: EmailHandlerEnv,
  sessionId: string,
  args: {
    fromAddr: string;
    toAddr: string;
    subject: string | null;
    inReplyTo: string | null;
    emailReferences: string | null;
  }
): Promise<ThreadColumns> {
  const newThreadId = crypto.randomUUID();
  const participants = participantKey([args.fromAddr, args.toAddr]);
  try {
    const db = getDb(env.DB);
    const referenced = [
      ...new Set([
        ...parseMessageIdList(args.inReplyTo),
        ...parseMessageIdList(args.emailReferences),
      ]),
    ];

    // Two bounded reads, not a table scan. The header tier is an exact lookup;
    // the weak tier only ever needs rows this person is already party to.
    const byMessageId = referenced.length
      ? await db
          .select({
            threadId: inboundEmails.threadId,
            messageId: inboundEmails.messageId,
            subject: inboundEmails.subject,
            fromAddress: inboundEmails.fromAddress,
            toAddress: inboundEmails.toAddress,
          })
          .from(inboundEmails)
          .where(inArray(inboundEmails.messageId, referenced))
          .limit(referenced.length)
      : [];

    const recent = await db
      .select({
        threadId: inboundEmails.threadId,
        messageId: inboundEmails.messageId,
        subject: inboundEmails.subject,
        fromAddress: inboundEmails.fromAddress,
        toAddress: inboundEmails.toAddress,
      })
      .from(inboundEmails)
      .where(eq(inboundEmails.fromAddress, args.fromAddr))
      .orderBy(desc(inboundEmails.receivedAt))
      .limit(THREAD_CANDIDATE_WINDOW);

    const candidates = [...byMessageId, ...recent].map((r) => ({
      threadId: r.threadId,
      messageId: r.messageId,
      normalizedSubject: normalizeThreadSubject(r.subject),
      participants: participantKey([r.fromAddress, r.toAddress]),
    }));

    const { threadId, basis } = resolveThread(
      {
        inReplyTo: args.inReplyTo,
        emailReferences: args.emailReferences,
        subject: args.subject,
        participants,
      },
      candidates,
      newThreadId
    );

    const [existing] = await db
      .select({ n: sql<number>`count(*)` })
      .from(inboundEmails)
      .where(eq(inboundEmails.threadId, threadId));

    return {
      threadId,
      threadPosition: Number(existing?.n ?? 0) + 1,
      threadBasis: basis,
    };
  } catch (err) {
    await logError(env.DB, {
      level: "warn",
      source: SOURCE,
      message: "thread resolution failed; starting a new thread",
      error: err,
      sessionId,
    });
    return { threadId: newThreadId, threadPosition: 1, threadBasis: "new" };
  }
}

async function resolveSenderColumns(
  env: EmailHandlerEnv,
  sessionId: string,
  fromAddr: string,
  bodyText: string
): Promise<SenderIdentityColumns> {
  try {
    const identity = await resolveSenderIdentity(getDb(env.DB), {
      fromAddress: fromAddr,
      bodyText,
    });
    if (identity.matches.length === 0) return NO_SENDER_MATCH;
    return {
      matchedEntities: JSON.stringify(identity.matches),
      matchedEntityType: identity.best?.entityType ?? null,
      matchedEntityId: identity.best?.entityId ?? null,
      matchBasis: identity.best?.basis ?? "none",
      matchConfidence: identity.best?.confidence ?? null,
    };
  } catch (err) {
    await logError(env.DB, {
      level: "warn",
      source: SOURCE,
      message: "sender identity resolution failed; recording no-match",
      error: err,
      sessionId,
      context: { from: fromAddr },
    }).catch(() => {});
    return { ...NO_SENDER_MATCH, matchedEntities: null };
  }
}

/**
 * OPE-763 — every sender-authenticity signal on the message, captured once.
 *
 * Returned as ONE object that is spread into every `inbound_emails` insert,
 * rather than nine fields threaded through four call sites. That shape is the
 * point: OPE-762 landed the same week because `body_text`/`body_html` were
 * added to the main insert and the two "mirror" inserts were not updated. Nine
 * more fields copied by hand into four places would have reproduced it at
 * scale. A spread cannot be half-applied.
 *
 * ⚠️ REPORT-ONLY. Nothing here branches, blocks, routes or sends. The
 * trusted-sender fast-path still calls `parseEmailAuth` on its own, and that
 * function is untouched — see the note on `parseEmailAuthDetail`.
 */
export interface SenderSignals {
  authResultsRaw: string | null;
  spfResult: string | null;
  dkimResult: string | null;
  dmarcResult: string | null;
  senderAuth: SenderAuthVerdict;
  fromDisplayName: string | null;
  replyTo: string | null;
  returnPath: string | null;
  sendingHost: string | null;
}

/** Cap on each captured header, so a pathological one cannot bloat the row. */
const HEADER_STORE_MAX = 2_000;

const clip = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t ? t.slice(0, HEADER_STORE_MAX) : null;
};

export function extractSenderSignals(
  headers: { get(name: string): string | null } | undefined,
  parsed: Email
): SenderSignals {
  const auth = parseEmailAuthDetail(headers?.get("Authentication-Results"));

  // The LAST `Received` hop is the one closest to the origin in a header block
  // that reads newest-first, so `parsed.headers` order matters. Take the first
  // `from <host>` token: on the OPE-763 specimen that is
  // `PH0PR09MB11424.namprd09.prod.outlook.com`, which is checkable.
  let sendingHost: string | null = null;
  const received = parsed.headers?.filter((h) => h.key?.toLowerCase() === "received") ?? [];
  for (const h of received) {
    const m = /\bfrom\s+([A-Za-z0-9._-]+\.[A-Za-z]{2,})/i.exec(h.value ?? "");
    if (m) {
      sendingHost = m[1].toLowerCase();
      break;
    }
  }

  // `replyTo` is an array and each entry may be a group rather than a mailbox;
  // `address` is undefined on a group, so filter rather than assume.
  const replyTo =
    parsed.replyTo
      ?.map((a) => ("address" in a ? a.address : null))
      .filter((a): a is string => !!a)
      .join(", ") || null;

  return {
    authResultsRaw: clip(auth.raw),
    spfResult: auth.spf,
    dkimResult: auth.dkim,
    dmarcResult: auth.dmarc,
    senderAuth: auth.verdict,
    // Deliberately NOT lowercased and NOT defaulted to the address: a display
    // name that merely repeats the address is a real, different observation
    // from having none, and both differ from `"Jeremy Hall" <random@gmail.com>`.
    fromDisplayName: clip(parsed.from && "name" in parsed.from ? parsed.from.name : null),
    replyTo: clip(replyTo),
    returnPath: clip(parsed.returnPath),
    sendingHost: clip(sendingHost),
  };
}

/** Persist the audit row for a spam-quarantined message. Mirrors the
 *  normal INSERT path but writes intent='spam', skips forward, skips
 *  workflow create. */
export async function insertSpamAuditRow(
  // OPE-762 — takes a `db` like its sibling `insertAuditNoopRow`, rather than
  // building one from `env.DB` internally. The docblock has always claimed the
  // two mirror each other; they did not, and the drift is why one of them grew
  // the body columns and the other did not. `env` stays for error logging only.
  db: Db,
  args: {
    env: EmailHandlerEnv;
    sessionId: string;
    fromAddr: string;
    toAddr: string;
    subject: string;
    bodyTextExcerpt: string;
    /**
     * OPE-762 — the full stored body, on the SPAM path too.
     *
     * These two were simply absent from this insert. The values are computed at
     * the top of `email()` and were already in scope at the call site; nobody
     * passed them. OPE-156 added `body_text`/`body_html` to the main insert and
     * the two terminal audit inserts that "mirror" it were not updated — the
     * divergence a mirror comment invites.
     *
     * Effect measured in prod 2026-09-02: 14 of 14 `intent='spam'` rows since
     * 2026-07-01 have NULL for both columns. 100%, not a sample. So a spam
     * misclassification destroys its own evidence in the same transaction as it
     * is made, and the classifier's accuracy is not merely unmeasured but
     * unmeasurable — the cases most worth reviewing are exactly the ones erased.
     */
    bodyTextStored: string | null;
    bodyHtmlStored: string | null;
    /** OPE-763 — captured once by `extractSenderSignals`, spread into the row. */
    senderSignals: SenderSignals;
    /** OPE-764 — resolved once at ingest, spread into the row. */
    senderIdentity: SenderIdentityColumns;
    threadColumns: ThreadColumns;
    message: import("@cloudflare/workers-types").ForwardableEmailMessage;
    parsed: Email;
    attachmentCount: number;
    routing: RoutingDecision;
  }
  // OPE-803 — returns the id it generated, so the caller can attach the
  // triple observation to the row it just wrote. `null` on the catch path:
  // the audit insert is best-effort and always has been, and a failed insert
  // must not become a failed handler.
): Promise<string | null> {
  const {
    env,
    sessionId,
    fromAddr,
    toAddr,
    subject,
    bodyTextExcerpt,
    bodyTextStored,
    bodyHtmlStored,
    senderSignals,
    senderIdentity,
    threadColumns,
    message,
    parsed,
    attachmentCount,
    routing,
  } = args;
  const now = new Date();
  const messageId = (parsed.messageId || "").trim() || null;
  const rowId = crypto.randomUUID();
  try {
    await db
      .insert(inboundEmails)
      .values({
        id: rowId,
        receivedAt: now,
        fromAddress: fromAddr,
        toAddress: toAddr,
        subject: subject || null,
        intent: "spam",
        status: "forwarded",
        workflowInstanceId: null,
        bodyTextExcerpt: bodyTextExcerpt || null,
        bodyText: bodyTextStored,
        bodyHtml: bodyHtmlStored,
        ...senderSignals,
        ...senderIdentity,
        ...threadColumns,
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
    return rowId;
  } catch (err) {
    await logError(env.DB, {
      source: SOURCE,
      message: "failed to insert spam-quarantine audit row",
      error: err,
      sessionId,
      context: { from: fromAddr, to: toAddr, subject },
    });
    // No row, so nothing to attach an observation to.
    return null;
  }
}

/**
 * OPE-803 — record what the event-triple detector saw on a quarantined row.
 *
 * Written to `admin_actions`, alongside the `dedup.*` observations, rather than
 * to a new column: this is evidence for a decision John has not made yet, and
 * a decision that may be "no". A migration would outlive the question.
 *
 * ⚠️ Records MISSES as well as hits. A row that says
 * `{hit:false, read:"excerpt", truncated:true}` is saying "I could not see the
 * text", which is a different fact from "there was no event here" — and the
 * difference is the whole of OPE-804, one lane over. Without it, the dry-run
 * that gates the flag would count 18 discarded bodies as 18 clean negatives.
 *
 * Never throws. This is telemetry attached to a message that has already been
 * quarantined; failing the handler over it would turn an observation into an
 * outage.
 */
async function recordSpamTripleObservation(
  db: ReturnType<typeof getDb>,
  args: { inboundEmailId: string; triple: TripleResult }
): Promise<void> {
  try {
    await db.insert(adminActions).values({
      action: "spam.event_triple",
      actorUserId: null,
      targetType: "inbound_email",
      targetId: args.inboundEmailId,
      payloadJson: JSON.stringify({
        hit: args.triple.hit,
        // Verbatim spans, never parsed values. These are evidence that a claim
        // was MADE, never evidence that it is true — the sender is a broker and
        // nothing here is ever a citation.
        name: args.triple.name,
        dateText: args.triple.dateText,
        place: args.triple.place,
        read: args.triple.read,
        truncated: args.triple.truncated,
      }),
      createdAt: new Date(),
    });
  } catch {
    // Intentionally silent — see the note above.
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
    /**
     * OPE-762 — scope 1 says "every inbound row regardless of classified
     * intent", and this terminal path is an inbound row. It carried the same
     * omission as the spam path for the same reason (both "mirror" the main
     * insert, which grew the columns later).
     *
     * REQUIRED, not optional. Both existing callers already have these values
     * in scope (computed near the top of `email()`), so requiring them costs
     * nothing today and makes the compiler — rather than a reviewer — the thing
     * that catches the third caller. An optional field with `?? null` would
     * have reproduced this ticket exactly: silently absent, indistinguishable
     * from a message that genuinely had no body.
     */
    bodyTextStored: string | null;
    bodyHtmlStored: string | null;
    /** OPE-763 — same object, same reason: a spread cannot be half-applied. */
    senderSignals: SenderSignals;
    /** OPE-764 — likewise. */
    senderIdentity: SenderIdentityColumns;
    threadColumns: ThreadColumns;
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
      bodyText: args.bodyTextStored,
      bodyHtml: args.bodyHtmlStored,
      ...args.senderSignals,
      ...args.senderIdentity,
      ...args.threadColumns,
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

/**
 * OPE-311 — cheap pre-filter for GSC click-milestone mail.
 *
 * Two shapes, because the mail reaches us two ways: straight from Google, and
 * forwarded by a human (which rewrites the From but keeps the subject). Kept
 * loose on purpose — the authoritative parse lives in the main app's
 * parseGscMilestoneEmail, and a false positive here costs one no-op request,
 * whereas a false negative loses a milestone we cannot recover later.
 */
export function looksLikeGscMilestone(fromAddr: string, subject: string): boolean {
  if (fromAddr.toLowerCase().includes("sc-noreply@google.com")) return true;
  // Milestone congrats mail.
  if (/reaching\s+[\d.,]+\s*k?\s+(clicks|impressions)\s+in\s+\d+\s+days/i.test(subject)) {
    return true;
  }
  // OPE-344 — the monthly "Search performance" report, when a human forwards it
  // and the sender is therefore no longer sc-noreply. Mail direct from Google
  // already matched on the address above; this is only the forward path, which
  // is the OPE-311 lesson (forwarded copies lose the sender).
  return /Your\s+\w+\s+Search performance/i.test(subject);
}
