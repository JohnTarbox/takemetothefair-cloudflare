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
import { getDb } from "./db.js";
import { inboundEmails, users } from "./schema.js";
import { eq, sql } from "drizzle-orm";
import { resolveIntent, shouldForwardToAdmin, type EmailIntent } from "./email-intents.js";

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

    // 3. Resolve intent
    const intent = resolveIntent(toAddr);

    // 4. Forward to admin synchronously if applicable.
    //    Lifecycle: ForwardableEmailMessage cannot survive into a workflow
    //    step. This is the only chance.
    if (shouldForwardToAdmin(intent)) {
      await forwardToAdminBestEffort(message, env, `intent:${intent}`, sessionId);
    }

    // 5. Pick URL from body (used by `submit` intent only, but stored
    //    unconditionally so the row is self-contained for future intents).
    const parsedUrl = pickPrimaryUrl(bodyText, bodyHtml);

    // 5b. Capture Message-ID for dedup. RFC 5322 §3.6.4 guarantees a
    //     globally unique value when present; absence is a real signal
    //     (automated senders sometimes omit it) — those messages skip
    //     dedup and proceed with the legacy "always insert" behavior.
    const messageId = (parsed.messageId || "").trim() || null;

    // 6. INSERT inbound_emails row, deduping on message_id.
    //    onConflictDoNothing pairs with the partial UNIQUE index added
    //    in drizzle/0073. We pass NO target — bare `ON CONFLICT DO
    //    NOTHING` matches any unique-constraint violation on the table,
    //    which in practice means only the partial message_id index
    //    (the PK is randomUUID and never collides; no other UNIQUEs).
    //    Why not pass `target: messageId`: SQLite requires partial-
    //    index conflict targets to repeat the partial WHERE in the
    //    conflict clause, AND Drizzle's `onConflictDoNothing` only
    //    accepts a `where` field that gets emitted AFTER `DO NOTHING`
    //    (invalid syntax) — there's no API path to emit the WHERE
    //    BEFORE `DO NOTHING` where SQLite actually wants it. Bare
    //    no-target form sidesteps the whole issue. Hit twice in prod
    //    2026-05-18; this is the third (and verified) attempt.
    //    .returning() lets us detect the duplicate case — an empty
    //    array means another delivery of this same message already
    //    landed and is being processed by its workflow.
    const rowId = crypto.randomUUID();
    const now = new Date();
    let inserted: { id: string }[];
    try {
      const db = getDb(env.DB);
      inserted = await db
        .insert(inboundEmails)
        .values({
          id: rowId,
          receivedAt: now,
          fromAddress: fromAddr,
          toAddress: toAddr,
          subject: subject || null,
          intent,
          status: "received",
          workflowInstanceId: null,
          bodyTextExcerpt: bodyTextExcerpt || null,
          parsedUrl,
          attachmentCount,
          rawSize: message.rawSize,
          error: null,
          messageId,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: inboundEmails.id });
    } catch (err) {
      await logError(env.DB, {
        source: SOURCE,
        message: "failed to insert inbound_emails row; aborting workflow create",
        error: err,
        sessionId,
        context: { from: fromAddr, to: toAddr, subject, intent },
      });
      return;
    }

    if (inserted.length === 0) {
      // Duplicate delivery — message_id matched an existing row. Skip
      // workflow create; the original delivery's workflow is handling it.
      await logError(env.DB, {
        level: "warn",
        source: SOURCE,
        message: "duplicate inbound delivery; skipping workflow create",
        sessionId,
        context: { from: fromAddr, to: toAddr, subject, intent, messageId },
      });
      return;
    }

    // 7. Create workflow instance + record its id back on the row.
    //    ctx.waitUntil — UPDATE doesn't need to block message ack.
    let workflowInstanceId: string;
    try {
      const instance = await env.INBOUND_EMAIL.create({
        params: { messageRowId: rowId, intent },
        // 7-day retention keeps instance state visible long enough to
        // debug a failure cluster while keeping storage flat as volume
        // grows. See workflows/inbound-email.ts header.
        retention: { successRetention: "7 days", errorRetention: "7 days" },
      });
      workflowInstanceId = instance.id;
    } catch (err) {
      // Workflow creation failed — row is still in 'received' state;
      // an admin sweep could re-create the workflow from row ID later.
      await logError(env.DB, {
        source: SOURCE,
        message: "INBOUND_EMAIL.create failed; row remains in 'received' state",
        error: err,
        sessionId,
        context: { messageRowId: rowId, intent, from: fromAddr },
      });
      return;
    }

    ctx.waitUntil(
      (async () => {
        try {
          const db = getDb(env.DB);
          await db
            .update(inboundEmails)
            .set({ workflowInstanceId })
            .where(eq(inboundEmails.id, rowId));
        } catch (err) {
          await logError(env.DB, {
            level: "warn",
            source: SOURCE,
            message: "failed to write workflow_instance_id back to row",
            error: err,
            sessionId,
            context: { messageRowId: rowId, workflowInstanceId },
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
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const cleaned = cleanUrl(m[0]);
    if (cleaned) return cleaned;
  }
  for (const m of html.matchAll(/href=["']([^"']+)["']/g)) {
    const cleaned = cleanUrl(m[1]);
    if (cleaned) return cleaned;
  }
  return null;
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
