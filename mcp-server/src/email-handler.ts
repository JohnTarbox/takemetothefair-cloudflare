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
 *        extraction; revisit when CF Email Sending GA's and we have a
 *        real volume signal.
 *   4. POST the extracted event payload to /api/suggest-event/submit
 *      with source: "email" — lands as PENDING for admin review.
 *   5. Queue an auto-reply (via the existing EMAIL_JOBS → Resend path)
 *      confirming receipt or explaining the failure.
 *
 * Failure modes:
 *   - PostalMime parse failure → forward raw to admin, no auto-reply
 *     (sender may not even be parseable).
 *   - No URL in body → forward to admin, auto-reply asks for a link.
 *   - URL fetch / AI extract failure → forward to admin, auto-reply.
 *   - /submit endpoint failure → forward to admin, auto-reply.
 *
 * What we don't do (deferred):
 *   - Attachment processing (PDFs, images). The auto-reply notes this.
 *   - HMAC-signed reply routing — only useful when we expect replies.
 *   - DMARC/SPF check beyond what CF Email Routing already does.
 *   - Free-text AI extraction when no URL is present.
 */

import PostalMime, { type Email } from "postal-mime";

// ---------------------------------------------------------------------------
// Env shape required by this module
// ---------------------------------------------------------------------------
export interface EmailHandlerEnv {
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

// ---------------------------------------------------------------------------
// Entry point — wired from src/index.ts default export
// ---------------------------------------------------------------------------
export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: EmailHandlerEnv,
  ctx: ExecutionContext
): Promise<void> {
  const toAddr = message.to.toLowerCase().trim();

  // Anything not routed to submit@ falls through to admin forwarding. CF
  // Email Routing should only deliver matching routes here, but defense
  // in depth — if someone adds a future route pointing at this Worker
  // and we don't have a branch for it, the admin still sees it.
  if (toAddr !== SUBMIT_ADDRESS) {
    await forwardToAdmin(message, env, `unroutable: to=${toAddr}`);
    return;
  }

  // Parse MIME. PostalMime accepts a ReadableStream.
  let parsed: Email;
  try {
    parsed = await PostalMime.parse(message.raw);
  } catch (err) {
    console.error("[email:submit] PostalMime parse failed", err);
    await forwardToAdmin(message, env, `parse-failed: ${errMsg(err)}`);
    return;
  }

  const fromAddr = (parsed.from?.address || message.from || "").toLowerCase().trim();
  const subject = (parsed.subject || "").slice(0, 200);
  const bodyText = (parsed.text || "").slice(0, MAX_BODY_LEN);
  const bodyHtml = parsed.html || "";
  const hasAttachments = (parsed.attachments?.length ?? 0) > 0;

  if (!fromAddr) {
    console.warn("[email:submit] missing from-address; forwarding");
    await forwardToAdmin(message, env, "missing-from");
    return;
  }

  // Per-sender rate limit.
  const allowed = await checkSenderRateLimit(env.OAUTH_KV, fromAddr);
  if (!allowed) {
    console.warn(`[email:submit] rate-limited: from=${fromAddr}`);
    // Silently drop. Replying to a rate-limited sender creates a
    // reflective spam vector. The dashboard log is the audit trail.
    return;
  }

  // Find a primary URL to feed the importer. Prefer the first http(s)
  // URL in the text body; fall back to scanning HTML hrefs.
  const url = pickPrimaryUrl(bodyText, bodyHtml);

  if (!url) {
    console.warn(`[email:submit] no URL in body from=${fromAddr} subject="${subject}"`);
    await forwardToAdmin(message, env, "no-url");
    ctx.waitUntil(
      queueAutoReply(env, {
        to: fromAddr,
        kind: "no-url",
        subject,
        hasAttachments,
      })
    );
    return;
  }

  // Fetch + AI-extract via the main app's URL-import pipeline.
  const extracted = await extractEventFromUrl(env, url);
  if (!extracted) {
    console.warn(`[email:submit] extract failed from=${fromAddr} url=${url}`);
    await forwardToAdmin(message, env, `extract-failed: ${url}`);
    ctx.waitUntil(queueAutoReply(env, { to: fromAddr, kind: "extract-failed", subject, url }));
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
    console.error(`[email:submit] submit failed from=${fromAddr}: ${submitted.error}`);
    await forwardToAdmin(message, env, `submit-failed: ${submitted.error}`);
    ctx.waitUntil(queueAutoReply(env, { to: fromAddr, kind: "submit-failed", subject }));
    return;
  }

  console.log(`[email:submit] created event ${submitted.slug} from=${fromAddr}`);
  ctx.waitUntil(
    queueAutoReply(env, {
      to: fromAddr,
      kind: "ok",
      subject,
      eventName: extracted.name,
      hasAttachments,
    })
  );
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
  url: string
): Promise<ExtractedEvent | null> {
  // 1. Fetch + parse the URL.
  const fetchUrl = `${env.MAIN_APP_URL}/api/admin/import-url/fetch?url=${encodeURIComponent(url)}`;
  let fetchRes: Response;
  try {
    fetchRes = await fetch(fetchUrl, {
      headers: { "x-internal-key": env.INTERNAL_API_KEY },
    });
  } catch (err) {
    console.error("[email:submit] fetch endpoint network error", err);
    return null;
  }
  if (!fetchRes.ok) return null;
  const fetched = (await fetchRes.json().catch(() => null)) as
    | {
        success: true;
        content: string;
        title?: string | null;
        description?: string | null;
        ogImage?: string | null;
        jsonLd?: unknown;
      }
    | { success: false; error: string }
    | null;
  if (!fetched || !fetched.success) return null;

  // 2. AI-extract.
  const extractRes = await fetch(`${env.MAIN_APP_URL}/api/admin/import-url/extract`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-key": env.INTERNAL_API_KEY,
    },
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
  }).catch((err) => {
    console.error("[email:submit] extract endpoint network error", err);
    return null;
  });
  if (!extractRes || !extractRes.ok) return null;
  const extracted = (await extractRes.json().catch(() => null)) as
    | { success: true; events: ExtractedEvent[]; count: number }
    | { success: false; error: string }
    | null;
  if (!extracted || !extracted.success || extracted.events.length === 0) return null;

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
      headers: {
        "Content-Type": "application/json",
        "x-internal-key": env.INTERNAL_API_KEY,
      },
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
  reason: string
): Promise<void> {
  if (!env.SUBMIT_ADMIN_FORWARD) {
    console.warn(`[email:submit] no SUBMIT_ADMIN_FORWARD set; dropping (reason=${reason})`);
    return;
  }
  try {
    await message.forward(env.SUBMIT_ADMIN_FORWARD);
    console.log(`[email:submit] forwarded to admin reason=${reason}`);
  } catch (err) {
    console.error(`[email:submit] admin forward failed reason=${reason}`, err);
  }
}

// ---------------------------------------------------------------------------
// Auto-reply (enqueued to EMAIL_JOBS; queue consumer sends via Resend)
// ---------------------------------------------------------------------------

type ReplyContext =
  | { to: string; kind: "ok"; subject: string; eventName: string; hasAttachments: boolean }
  | { to: string; kind: "no-url"; subject: string; hasAttachments: boolean }
  | { to: string; kind: "extract-failed"; subject: string; url: string }
  | { to: string; kind: "submit-failed"; subject: string };

async function queueAutoReply(env: EmailHandlerEnv, ctx: ReplyContext): Promise<void> {
  if (!env.EMAIL_JOBS) {
    console.warn("[email:submit] EMAIL_JOBS unbound; skipping auto-reply");
    return;
  }
  const msg = buildReply(ctx);
  await env.EMAIL_JOBS.send(msg).catch((err) => {
    console.error("[email:submit] queue send failed", err);
  });
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
