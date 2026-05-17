/**
 * Inbound email handler — receives mail sent to submit@meetmeatthefair.com
 * via Cloudflare Email Routing and turns it into a community event
 * submission.
 *
 * Pipeline (V1):
 *   1. PostalMime parses the raw message (text/html bodies, headers).
 *   2. Per-sender rate limit (OAUTH_KV, 5/24h) — cheap abuse guard. CF
 *      Email Routing already applies basic spam filtering upstream.
 *   3. Extract the first URL from text/HTML body.
 *      - If found: call the main app's URL-import pipeline
 *        (/api/admin/import-url/fetch then /extract) with X-Internal-Key.
 *      - If not found: forward the raw email to the admin Gmail and tell
 *        the sender to include a link. V1 doesn't attempt free-text AI
 *        extraction; revisit when we have a real volume signal.
 *   4. POST the extracted event payload to /api/suggest-event/submit
 *      with source: "email" — lands as PENDING for admin review.
 *   5. Queue an auto-reply (via EMAIL_JOBS → env.EMAIL.send) confirming
 *      receipt or explaining the failure.
 *
 * Diagnostics:
 *   Every handler invocation generates a `sessionId` (UUID) that's
 *   stamped into the `context` field of every log row written via
 *   `logError`. To trace a single email end-to-end from /admin/logs,
 *   filter `source LIKE 'mcp:email-handler%'` and search for the
 *   sessionId substring. The internal API's `{success:false,error}`
 *   payloads are read and surfaced — the real Workers AI timeout
 *   message lands in the log instead of being collapsed to "extract failed".
 *
 * Failure modes (all logged + forwarded to admin Gmail):
 *   - PostalMime parse failure
 *   - No URL in body
 *   - URL fetch failure (network or non-2xx)
 *   - AI extract failure (with the real upstream error string)
 *   - /submit endpoint failure
 *
 * What we don't do (deferred):
 *   - Attachment processing (PDFs, images).
 *   - HMAC-signed reply routing.
 *   - DMARC/SPF check beyond what CF Email Routing already does.
 *   - Free-text AI extraction when no URL is present.
 */

import PostalMime, { type Email } from "postal-mime";
import { logError } from "./logger.js";

// ---------------------------------------------------------------------------
// Env shape required by this module
// ---------------------------------------------------------------------------
export interface EmailHandlerEnv {
  /** D1 binding — used by `logError` to persist diagnostics to `error_logs`. */
  DB: D1Database;
  /** OAuth KV is reused with an "email-submit:" prefix for per-sender
   *  rate limiting. Intentional cross-use — saves a binding. */
  OAUTH_KV: KVNamespace;
  /** Outbound auto-reply queue — drained by handleEmailBatch in queue-consumers.ts. */
  EMAIL_JOBS?: Queue<EmailJobMessage>;
  /** Main app base URL — same as the rest of the MCP Worker. */
  MAIN_APP_URL: string;
  /** Shared secret for internal API calls — same key used by IndexNow, admin tools. */
  INTERNAL_API_KEY: string;
  /** Where unparseable / failed-extraction emails are forwarded for manual review.
   *  Must be a verified destination address in Cloudflare Email Routing. */
  SUBMIT_ADMIN_FORWARD?: string;
}

/** Threaded into every helper so they can log with the same sessionId
 *  and against the same D1 binding without bloating every signature. */
interface LogCtx {
  db: D1Database;
  sessionId: string;
}

// Outbound EmailJobMessage shape (mirror of queue-consumers.ts).
interface EmailJobMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
  source: string;
}

// ForwardableEmailMessage is declared globally by @cloudflare/workers-types.
// Re-export it for callers (the index.ts entry) so they don't need a
// separate import path.
export type { ForwardableEmailMessage } from "@cloudflare/workers-types";

const SUBMIT_ADDRESS = "submit@meetmeatthefair.com";
const PER_SENDER_LIMIT = 5;
const PER_SENDER_WINDOW_SEC = 86_400;
const MAX_BODY_LEN = 50_000; // characters fed into AI extractor
const SOURCE = "mcp:email-handler";

// ---------------------------------------------------------------------------
// Entry point — wired from src/index.ts default export
// ---------------------------------------------------------------------------
export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: EmailHandlerEnv,
  ctx: ExecutionContext
): Promise<void> {
  // Single sessionId per inbound email — stamped into every log row's
  // context.sessionId. The /admin/logs search box does substring match,
  // so admins can paste this UUID to reconstruct one email's full trace.
  const sessionId = crypto.randomUUID();
  const logCtx: LogCtx = { db: env.DB, sessionId };

  // Top-level try/catch — anything unhandled below (PostalMime crashes,
  // unexpected runtime errors) gets a row in error_logs and admin forward
  // before re-throwing. CF won't retry email dispatch, so re-throwing is
  // mostly for surfacing in CF's own metrics rather than retry behavior.
  try {
    const toAddr = message.to.toLowerCase().trim();

    // Anything not routed to submit@ falls through to admin forwarding. CF
    // Email Routing should only deliver matching routes here, but defense
    // in depth — if someone adds a future route pointing at this Worker
    // and we don't have a branch for it, the admin still sees it.
    if (toAddr !== SUBMIT_ADDRESS) {
      await logError(env.DB, {
        level: "warn",
        source: SOURCE,
        message: "inbound message addressed to non-submit@ recipient",
        sessionId,
        context: { from: message.from, to: toAddr, rawSize: message.rawSize },
      });
      await forwardToAdmin(message, env, logCtx, `unroutable: to=${toAddr}`);
      return;
    }

    // Parse MIME. PostalMime accepts a ReadableStream.
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
      await forwardToAdmin(message, env, logCtx, `parse-failed: ${errMsg(err)}`);
      return;
    }

    const fromAddr = (parsed.from?.address || message.from || "").toLowerCase().trim();
    const subject = (parsed.subject || "").slice(0, 200);
    const bodyText = (parsed.text || "").slice(0, MAX_BODY_LEN);
    const bodyHtml = parsed.html || "";
    const hasAttachments = (parsed.attachments?.length ?? 0) > 0;

    if (!fromAddr) {
      await logError(env.DB, {
        level: "warn",
        source: SOURCE,
        message: "missing from-address; forwarding to admin",
        sessionId,
        context: { to: toAddr, subject, rawSize: message.rawSize },
      });
      await forwardToAdmin(message, env, logCtx, "missing-from");
      return;
    }

    // Per-sender rate limit.
    const allowed = await checkSenderRateLimit(env.OAUTH_KV, fromAddr);
    if (!allowed) {
      // Silently drop (no auto-reply — would create a reflective spam vector)
      // but log so admins can see when senders are hitting the limit.
      await logError(env.DB, {
        level: "warn",
        source: SOURCE,
        message: "rate-limited sender; dropped without reply",
        sessionId,
        context: {
          from: fromAddr,
          subject,
          limit: PER_SENDER_LIMIT,
          windowSec: PER_SENDER_WINDOW_SEC,
        },
      });
      return;
    }

    // Find a primary URL to feed the importer. Prefer the first http(s)
    // URL in the text body; fall back to scanning HTML hrefs.
    const url = pickPrimaryUrl(bodyText, bodyHtml);

    if (!url) {
      await logError(env.DB, {
        level: "info",
        source: SOURCE,
        message: "no URL in body; sending no-url auto-reply",
        sessionId,
        context: {
          from: fromAddr,
          subject,
          hasAttachments,
          textLen: bodyText.length,
          htmlLen: bodyHtml.length,
        },
      });
      await forwardToAdmin(message, env, logCtx, "no-url");
      ctx.waitUntil(
        queueAutoReply(env, logCtx, { to: fromAddr, kind: "no-url", subject, hasAttachments })
      );
      return;
    }

    // Fetch + AI-extract via the main app's URL-import pipeline.
    const extracted = await extractEventFromUrl(env, logCtx, url, fromAddr, subject);
    if (!extracted) {
      // extractEventFromUrl already logged the specific failure with the
      // upstream error string. Just log the user-visible outcome here.
      await logError(env.DB, {
        level: "warn",
        source: SOURCE,
        message: "extract failed; sending extract-failed auto-reply",
        sessionId,
        context: { from: fromAddr, subject, url },
      });
      await forwardToAdmin(message, env, logCtx, `extract-failed: ${url}`);
      ctx.waitUntil(
        queueAutoReply(env, logCtx, { to: fromAddr, kind: "extract-failed", subject, url })
      );
      return;
    }

    // Submit. The main app's /api/suggest-event/submit will land this as
    // PENDING since source="email", and runs all the date-quality + URL
    // classification gates.
    const submitted = await submitEvent(env, {
      ...extracted,
      source: "email",
      sourceUrl: url,
      suggesterEmail: fromAddr,
    });

    if (!submitted.ok) {
      await logError(env.DB, {
        source: SOURCE,
        message: "submit endpoint rejected event",
        sessionId,
        context: {
          from: fromAddr,
          subject,
          url,
          submitError: submitted.error,
          extractedName: extracted.name,
          extractedStartDate: extracted.startDate ?? null,
        },
      });
      await forwardToAdmin(message, env, logCtx, `submit-failed: ${submitted.error}`);
      ctx.waitUntil(queueAutoReply(env, logCtx, { to: fromAddr, kind: "submit-failed", subject }));
      return;
    }

    await logError(env.DB, {
      level: "info",
      source: SOURCE,
      message: "event created from email submission",
      sessionId,
      context: { from: fromAddr, subject, url, slug: submitted.slug, eventName: extracted.name },
    });
    ctx.waitUntil(
      queueAutoReply(env, logCtx, {
        to: fromAddr,
        kind: "ok",
        subject,
        eventName: extracted.name,
        hasAttachments,
      })
    );
  } catch (err) {
    // Unhandled exception — surface in error_logs with all the context we
    // have, then forward the raw message to admin so it's not lost.
    await logError(env.DB, {
      source: SOURCE,
      message: "unhandled exception in handleInboundEmail",
      error: err,
      sessionId,
      context: { from: message.from, to: message.to, rawSize: message.rawSize },
    }).catch(() => {
      /* logger is already best-effort — swallow secondary failure */
    });
    await forwardToAdmin(message, env, logCtx, `unhandled-exception: ${errMsg(err)}`).catch(() => {
      /* forwarding failed too — admin will need to debug from logs */
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// URL extraction
// ---------------------------------------------------------------------------

// Strip surrounding markdown link wrappers, trailing punctuation, and
// non-http(s) schemes. Mailto / tel / file get dropped.
function cleanUrl(raw: string): string | null {
  const u = raw.trim().replace(/^[<("']+|[>)"',.;]+$/g, "");
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function pickPrimaryUrl(text: string, html: string): string | null {
  // 1. First valid http(s) URL anywhere in plain text. matchAll handles
  //    the case where multiple URLs appear (e.g., an event link followed
  //    by an unsubscribe link) — we walk them until cleanUrl accepts one.
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const cleaned = cleanUrl(m[0]);
    if (cleaned) return cleaned;
  }
  // 2. Fall back to first valid href in HTML. Same iteration — required
  //    because emails routinely embed a javascript:void(0) href before
  //    real links (cancel buttons, JS handlers, etc.), and we want the
  //    first *http(s)* link rather than the first href tag.
  for (const m of html.matchAll(/href=["']([^"']+)["']/g)) {
    const cleaned = cleanUrl(m[1]);
    if (cleaned) return cleaned;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main-app round-trips
// ---------------------------------------------------------------------------

interface ExtractedEvent {
  name: string;
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  venueName?: string | null;
  venueAddress?: string | null;
  venueCity?: string | null;
  venueState?: string | null;
  ticketUrl?: string | null;
  imageUrl?: string | null;
  categories?: string[] | null;
}

async function extractEventFromUrl(
  env: EmailHandlerEnv,
  logCtx: LogCtx,
  url: string,
  fromAddr: string,
  subject: string
): Promise<ExtractedEvent | null> {
  // 1. Fetch + parse the URL via the main app's import-url/fetch endpoint.
  //    SSRF guards, timeout, and User-Agent live on that endpoint, not here.
  const fetchUrl = `${env.MAIN_APP_URL}/api/admin/import-url/fetch?url=${encodeURIComponent(url)}`;
  let fetchRes: Response;
  try {
    fetchRes = await fetch(fetchUrl, { headers: { "x-internal-key": env.INTERNAL_API_KEY } });
  } catch (err) {
    await logError(logCtx.db, {
      source: `${SOURCE}:fetch`,
      message: "network error calling /api/admin/import-url/fetch",
      error: err,
      sessionId: logCtx.sessionId,
      context: { url, from: fromAddr, subject },
    });
    return null;
  }
  if (!fetchRes.ok) {
    const body = await fetchRes.text().catch(() => "<unreadable>");
    await logError(logCtx.db, {
      source: `${SOURCE}:fetch`,
      message: "import-url/fetch returned non-2xx",
      statusCode: fetchRes.status,
      sessionId: logCtx.sessionId,
      context: { url, status: fetchRes.status, bodyExcerpt: body.slice(0, 500) },
    });
    return null;
  }
  const fetched = (await fetchRes.json().catch((err) => {
    // Catch the parse error so we can log it with context.
    return { __parseError: err };
  })) as
    | {
        success: true;
        content: string;
        title?: string | null;
        description?: string | null;
        ogImage?: string | null;
        jsonLd?: unknown;
      }
    | { success: false; error: string }
    | { __parseError: unknown }
    | null;

  if (!fetched) {
    await logError(logCtx.db, {
      source: `${SOURCE}:fetch`,
      message: "import-url/fetch returned empty/null body",
      sessionId: logCtx.sessionId,
      context: { url },
    });
    return null;
  }
  if ("__parseError" in fetched) {
    await logError(logCtx.db, {
      source: `${SOURCE}:fetch`,
      message: "failed to parse import-url/fetch response as JSON",
      error: fetched.__parseError,
      sessionId: logCtx.sessionId,
      context: { url },
    });
    return null;
  }
  if (!fetched.success) {
    // Surface the actual error string the upstream endpoint returned
    // (e.g., "Page took too long to load", "Could not access page (403 Forbidden)").
    await logError(logCtx.db, {
      level: "warn",
      source: `${SOURCE}:fetch`,
      message: "import-url/fetch reported failure",
      sessionId: logCtx.sessionId,
      context: { url, upstreamError: fetched.error },
    });
    return null;
  }

  // 2. AI-extract via the main app's import-url/extract endpoint.
  let extractRes: Response | null;
  try {
    extractRes = await fetch(`${env.MAIN_APP_URL}/api/admin/import-url/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-key": env.INTERNAL_API_KEY },
      body: JSON.stringify({
        content: fetched.content,
        url,
        metadata: {
          title: fetched.title ?? null,
          description: fetched.description ?? null,
          ogImage: fetched.ogImage ?? null,
          jsonLd: fetched.jsonLd ?? null,
        },
      }),
    });
  } catch (err) {
    await logError(logCtx.db, {
      source: `${SOURCE}:extract`,
      message: "network error calling /api/admin/import-url/extract",
      error: err,
      sessionId: logCtx.sessionId,
      context: { url, contentLen: fetched.content.length },
    });
    return null;
  }
  if (!extractRes.ok) {
    const body = await extractRes.text().catch(() => "<unreadable>");
    await logError(logCtx.db, {
      source: `${SOURCE}:extract`,
      message: "import-url/extract returned non-2xx",
      statusCode: extractRes.status,
      sessionId: logCtx.sessionId,
      context: { url, status: extractRes.status, bodyExcerpt: body.slice(0, 500) },
    });
    return null;
  }
  const extracted = (await extractRes.json().catch((err) => ({ __parseError: err }))) as
    | { success: true; events: ExtractedEvent[]; count: number }
    | { success: false; error: string }
    | { __parseError: unknown }
    | null;

  if (!extracted) {
    await logError(logCtx.db, {
      source: `${SOURCE}:extract`,
      message: "import-url/extract returned empty/null body",
      sessionId: logCtx.sessionId,
      context: { url },
    });
    return null;
  }
  if ("__parseError" in extracted) {
    await logError(logCtx.db, {
      source: `${SOURCE}:extract`,
      message: "failed to parse import-url/extract response as JSON",
      error: extracted.__parseError,
      sessionId: logCtx.sessionId,
      context: { url },
    });
    return null;
  }
  if (!extracted.success) {
    // The single most important diagnostic: when /extract returns
    // `{success:false, error:"Workers AI multi-event extraction timed out
    // after 20000ms"}`, *that* is the message admins need to see — not
    // the generic "extract failed" we used to log.
    await logError(logCtx.db, {
      level: "warn",
      source: `${SOURCE}:extract`,
      message: "import-url/extract reported failure",
      sessionId: logCtx.sessionId,
      context: { url, upstreamError: extracted.error },
    });
    return null;
  }
  if (extracted.events.length === 0) {
    await logError(logCtx.db, {
      level: "warn",
      source: `${SOURCE}:extract`,
      message: "import-url/extract returned zero events",
      sessionId: logCtx.sessionId,
      context: { url },
    });
    return null;
  }

  // Take the first event. URL-import frequently returns multiple when a
  // promoter page lists several; for V1 we surface the first and let
  // admin handle the rest manually if needed.
  return extracted.events[0];
}

interface SubmitPayload extends ExtractedEvent {
  source: "email";
  sourceUrl?: string;
  suggesterEmail: string;
}

async function submitEvent(
  env: EmailHandlerEnv,
  payload: SubmitPayload
): Promise<{ ok: true; slug: string } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${env.MAIN_APP_URL}/api/suggest-event/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-key": env.INTERNAL_API_KEY },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, error: `network: ${errMsg(err)}` };
  }
  const body = (await res.json().catch(() => null)) as
    | { success: true; event: { slug: string } }
    | { success: false; error: string }
    | null;
  if (!res.ok || !body || !body.success) {
    return { ok: false, error: body && "error" in body ? body.error : `status ${res.status}` };
  }
  return { ok: true, slug: body.event.slug };
}

// ---------------------------------------------------------------------------
// Per-sender rate limit (KV)
// ---------------------------------------------------------------------------

export async function checkSenderRateLimit(kv: KVNamespace, fromAddr: string): Promise<boolean> {
  const key = `email-submit:${fromAddr}`;
  const raw = await kv.get(key);
  const count = raw ? Number.parseInt(raw, 10) || 0 : 0;
  if (count >= PER_SENDER_LIMIT) return false;
  await kv.put(key, String(count + 1), { expirationTtl: PER_SENDER_WINDOW_SEC });
  return true;
}

// ---------------------------------------------------------------------------
// Admin forwarding (always best-effort, never throws into the handler)
// ---------------------------------------------------------------------------

async function forwardToAdmin(
  message: ForwardableEmailMessage,
  env: EmailHandlerEnv,
  logCtx: LogCtx,
  reason: string
): Promise<void> {
  if (!env.SUBMIT_ADMIN_FORWARD) {
    await logError(logCtx.db, {
      level: "warn",
      source: SOURCE,
      message: "SUBMIT_ADMIN_FORWARD env not set; dropping forward attempt",
      sessionId: logCtx.sessionId,
      context: { reason, from: message.from, to: message.to },
    });
    return;
  }
  try {
    await message.forward(env.SUBMIT_ADMIN_FORWARD);
  } catch (err) {
    await logError(logCtx.db, {
      source: SOURCE,
      message: "message.forward to admin failed",
      error: err,
      sessionId: logCtx.sessionId,
      context: {
        reason,
        destination: env.SUBMIT_ADMIN_FORWARD,
        from: message.from,
        to: message.to,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Auto-reply (enqueued to EMAIL_JOBS; queue consumer sends via env.EMAIL)
// ---------------------------------------------------------------------------

type ReplyContext =
  | { to: string; kind: "ok"; subject: string; eventName: string; hasAttachments: boolean }
  | { to: string; kind: "no-url"; subject: string; hasAttachments: boolean }
  | { to: string; kind: "extract-failed"; subject: string; url: string }
  | { to: string; kind: "submit-failed"; subject: string };

async function queueAutoReply(
  env: EmailHandlerEnv,
  logCtx: LogCtx,
  replyCtx: ReplyContext
): Promise<void> {
  if (!env.EMAIL_JOBS) {
    await logError(logCtx.db, {
      level: "warn",
      source: SOURCE,
      message: "EMAIL_JOBS queue unbound; auto-reply skipped",
      sessionId: logCtx.sessionId,
      context: { kind: replyCtx.kind, to: replyCtx.to },
    });
    return;
  }
  const msg = buildReply(replyCtx);
  try {
    await env.EMAIL_JOBS.send(msg);
  } catch (err) {
    await logError(logCtx.db, {
      source: SOURCE,
      message: "EMAIL_JOBS.send (auto-reply enqueue) failed",
      error: err,
      sessionId: logCtx.sessionId,
      context: { kind: replyCtx.kind, to: replyCtx.to, subject: msg.subject },
    });
  }
}

export function buildReply(ctx: ReplyContext): EmailJobMessage {
  const replySubject = `Re: ${ctx.subject || "your event submission"}`.slice(0, 200);
  const supportLine = "If you didn't mean to submit an event, you can ignore this message.";

  switch (ctx.kind) {
    case "ok": {
      const attachmentNote = ctx.hasAttachments
        ? "\n\nNote: We don't process attachments yet. If your message had images or PDFs, please keep them handy in case our team has questions during review."
        : "";
      const text = `Thanks for submitting "${ctx.eventName}" to Meet Me at the Fair!

Your submission is being reviewed by our team. Approved events typically appear within 24 hours.${attachmentNote}

${supportLine}

— Meet Me at the Fair`;
      return {
        to: ctx.to,
        subject: replySubject,
        text,
        html: `<p>${escapeHtml(text).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`,
        source: "email:submit-reply",
      };
    }
    case "no-url": {
      const text = `Thanks for emailing Meet Me at the Fair!

We couldn't find a link to the event in your message. To submit an event, please reply with a URL to the event's official page (a fair website, ticket page, or social media post all work).

${ctx.hasAttachments ? "We don't process attachments yet, so please include a link rather than a flyer image or PDF.\n\n" : ""}${supportLine}

— Meet Me at the Fair`;
      return {
        to: ctx.to,
        subject: replySubject,
        text,
        html: `<p>${escapeHtml(text).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`,
        source: "email:submit-reply",
      };
    }
    case "extract-failed": {
      const text = `Thanks for emailing Meet Me at the Fair!

We couldn't extract event details from the page you linked (${ctx.url}). Our team has been notified and will review it manually. If you have a different link with clearer event details (date, location, hours), feel free to reply with it.

${supportLine}

— Meet Me at the Fair`;
      return {
        to: ctx.to,
        subject: replySubject,
        text,
        html: `<p>${escapeHtml(text).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`,
        source: "email:submit-reply",
      };
    }
    case "submit-failed": {
      const text = `Thanks for emailing Meet Me at the Fair!

We received your event submission but ran into a problem saving it. Our team has been notified and will follow up if needed.

${supportLine}

— Meet Me at the Fair`;
      return {
        to: ctx.to,
        subject: replySubject,
        text,
        html: `<p>${escapeHtml(text).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`,
        source: "email:submit-reply",
      };
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
