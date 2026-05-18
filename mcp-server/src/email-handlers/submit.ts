/**
 * `submit@` handler — the original event-submission flow, now repackaged
 * as a step body inside InboundEmailWorkflow.
 *
 * Pipeline:
 *   1. Require row.parsedUrl (extracted by entrypoint via pickPrimaryUrl).
 *      If missing → "no-url" auto-reply, no submission attempted.
 *   2. HTTP POST main-app /api/admin/import-url/fetch?url=...
 *      (with X-Internal-Key)
 *   3. HTTP POST main-app /api/admin/import-url/extract
 *      (with the fetched content + JSON-LD metadata; Workers AI extracts)
 *   4. HTTP POST main-app /api/suggest-event/submit
 *      (with source: "email" → lands as PENDING for admin review)
 *
 * Failure paths each return a distinct ReplyKind so buildReply can
 * tailor the sender-visible auto-reply. The original /extract endpoint
 * surfaces upstream errors (e.g., Workers AI timeouts) via its
 * `{success:false,error}` shape — we read those and stamp them into
 * the workflow's error context for /admin/logs visibility (mirrors the
 * PR #176 fix that surfaced the real upstream messages).
 */

import { logError } from "../logger.js";
import type { HandlerFn, HandlerResult } from "./types.js";

const SOURCE_FETCH = "mcp:email-handler:extract:fetch";
const SOURCE_EXTRACT = "mcp:email-handler:extract:ai";
const SOURCE_SUBMIT = "mcp:email-handler:submit";

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

export const handle: HandlerFn = async (env, ctx, row): Promise<HandlerResult> => {
  if (!row.parsedUrl) {
    return {
      replyKind: "no-url",
      replyParams: { subject: row.subject ?? "", hasAttachments: row.attachmentCount > 0 },
      status: "replied",
    };
  }

  const url = row.parsedUrl;
  const fromAddr = row.fromAddress;
  const subject = row.subject ?? "";

  // Step A: fetch URL via main-app /api/admin/import-url/fetch
  let fetchRes: Response;
  try {
    fetchRes = await fetch(
      `${env.MAIN_APP_URL}/api/admin/import-url/fetch?url=${encodeURIComponent(url)}`,
      { headers: { "x-internal-key": env.INTERNAL_API_KEY } }
    );
  } catch (err) {
    await logError(env.DB, {
      source: SOURCE_FETCH,
      message: "network error calling /api/admin/import-url/fetch",
      error: err,
      sessionId: ctx.sessionId,
      context: { url, from: fromAddr, subject },
    });
    return {
      replyKind: "extract-failed",
      replyParams: { subject, url },
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!fetchRes.ok) {
    await logError(env.DB, {
      source: SOURCE_FETCH,
      message: "import-url/fetch returned non-2xx",
      statusCode: fetchRes.status,
      sessionId: ctx.sessionId,
      context: { url, status: fetchRes.status },
    });
    return {
      replyKind: "extract-failed",
      replyParams: { subject, url },
      status: "failed",
      error: `fetch ${fetchRes.status}`,
    };
  }
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
  if (!fetched || !fetched.success) {
    await logError(env.DB, {
      level: "warn",
      source: SOURCE_FETCH,
      message: "import-url/fetch reported failure",
      sessionId: ctx.sessionId,
      context: { url, upstreamError: fetched && "error" in fetched ? fetched.error : "no-body" },
    });
    return {
      replyKind: "extract-failed",
      replyParams: { subject, url },
      status: "failed",
      error: fetched && "error" in fetched ? fetched.error : "fetch-empty-body",
    };
  }

  // Step B: AI-extract via main-app /api/admin/import-url/extract
  let extractRes: Response;
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
    await logError(env.DB, {
      source: SOURCE_EXTRACT,
      message: "network error calling /api/admin/import-url/extract",
      error: err,
      sessionId: ctx.sessionId,
      context: { url, contentLen: fetched.content.length },
    });
    return {
      replyKind: "extract-failed",
      replyParams: { subject, url },
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!extractRes.ok) {
    await logError(env.DB, {
      source: SOURCE_EXTRACT,
      message: "import-url/extract returned non-2xx",
      statusCode: extractRes.status,
      sessionId: ctx.sessionId,
      context: { url, status: extractRes.status },
    });
    return {
      replyKind: "extract-failed",
      replyParams: { subject, url },
      status: "failed",
      error: `extract ${extractRes.status}`,
    };
  }
  const extracted = (await extractRes.json().catch(() => null)) as
    | { success: true; events: ExtractedEvent[]; count: number }
    | { success: false; error: string }
    | null;
  if (!extracted || !extracted.success || extracted.events.length === 0) {
    const upstreamError =
      extracted && "error" in extracted
        ? extracted.error
        : extracted && extracted.success
          ? "zero events"
          : "no body";
    await logError(env.DB, {
      level: "warn",
      source: SOURCE_EXTRACT,
      message: "import-url/extract reported failure or zero events",
      sessionId: ctx.sessionId,
      context: { url, upstreamError },
    });
    return {
      replyKind: "extract-failed",
      replyParams: { subject, url },
      status: "failed",
      error: upstreamError,
    };
  }
  const first = extracted.events[0];

  // Step C: submit
  let submitRes: Response;
  try {
    submitRes = await fetch(`${env.MAIN_APP_URL}/api/suggest-event/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-key": env.INTERNAL_API_KEY },
      body: JSON.stringify({
        ...first,
        source: "email",
        sourceUrl: url,
        suggesterEmail: fromAddr,
      }),
    });
  } catch (err) {
    return {
      replyKind: "submit-failed",
      replyParams: { subject },
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const submitBody = (await submitRes.json().catch(() => null)) as
    | { success: true; event: { slug: string } }
    | { success: false; error: string }
    | null;
  if (!submitRes.ok || !submitBody || !submitBody.success) {
    const submitErr =
      submitBody && "error" in submitBody ? submitBody.error : `submit ${submitRes.status}`;
    await logError(env.DB, {
      source: SOURCE_SUBMIT,
      message: "submit endpoint rejected event",
      sessionId: ctx.sessionId,
      context: { from: fromAddr, subject, url, submitError: submitErr, extractedName: first.name },
    });
    return {
      replyKind: "submit-failed",
      replyParams: { subject },
      status: "failed",
      error: submitErr,
    };
  }

  return {
    replyKind: "ok",
    replyParams: {
      subject,
      eventName: first.name,
      hasAttachments: row.attachmentCount > 0,
    },
    status: "replied",
  };
};
