/**
 * Queue consumer handlers — drain email + IndexNow queues, do the actual
 * external-API work that the producer (main app or MCP tool) deferred.
 *
 * Why these live in the MCP Worker rather than a dedicated consumer Worker:
 * Cloudflare Pages projects can produce queue messages but cannot consume
 * them. The MCP server is our only "regular Worker," so it inherits the
 * consumer role for everything in this codebase.
 *
 * Message shapes are intentionally typed loosely — see the producer-side
 * canonical types at src/lib/queues/types.ts in the main app. We don't
 * import that file here because it would drag in main-app-only deps.
 */

import { getDb } from "./db.js";
import { indexnowSubmissions } from "./schema.js";
import { logError } from "./logger.js";
import { captureDiscrepancy, type FieldClass, type DetectedBy } from "./goodwill/capture.js";

const HOST = "meetmeatthefair.com";
const REPORT_API_BASE = "https://api.indexnow.org/IndexNow";

/**
 * Exponential backoff (seconds) for a queue retry, keyed off the message's
 * delivery `attempts` (1 on first delivery). Bare `m.retry()` re-delivers on the
 * queue's default schedule and can hot-loop a transient failure; an explicit
 * `delaySeconds` spaces retries out. Capped so a message still reaches the DLQ
 * within the retry budget rather than crawling.
 */
function backoffSeconds(attempts: number, baseSeconds: number, capSeconds: number): number {
  const a = Math.max(1, attempts);
  return Math.min(capSeconds, baseSeconds * 2 ** (a - 1));
}

/** Parse a `Retry-After` header (delta-seconds form) into a clamped delay, or null. */
function retryAfterSeconds(res: Response, capSeconds: number): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, capSeconds) : null;
}

// Mirror types from main app's src/lib/queues/types.ts. Kept inline (not
// imported) because mcp-server is its own workspace package.
type EmailJobMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
  source: string;
};

type IndexNowMessage = {
  urls: string[];
  source: string;
};

// GW1.1 (2026-06-03) — ingest_addverify discrepancy capture message.
// Mirrors src/lib/queues/types.ts:IngestDiscrepancyMessage in the main
// app. The consumer passes fields through to captureDiscrepancy
// verbatim — see goodwill/capture.ts for the 24-hour idempotence
// guard.
type IngestDiscrepancyMessage = {
  detectedBy: DetectedBy;
  eventId: string;
  fieldClass: FieldClass;
  authoritativeValue: string | null;
  authoritativeSourceKey: string | null;
  authoritativeSourceUrl: string | null;
  divergentValue: string | null;
  divergentSourceKey: string | null;
  divergentSourceUrl: string | null;
  confidence: number;
  notes: string;
};

type ConsumerEnv = {
  DB: D1Database;
  /** Cloudflare Email Service outbound binding (public beta).
   *  Bound via `[[send_email]]` in wrangler.toml. Optional only because
   *  TypeScript can't distinguish dev (where the binding may be absent)
   *  from prod — at runtime in prod it is always present. */
  EMAIL?: SendEmail;
  INDEXNOW_KEY?: string;
};

// ─── Email consumer ─────────────────────────────────────────────────────

const DEFAULT_FROM = "Meet Me at the Fair <notify@meetmeatthefair.com>";

async function sendViaCfEmail(
  msg: EmailJobMessage,
  binding: SendEmail
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  try {
    const res = await binding.send({
      from: msg.from ?? DEFAULT_FROM,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    });
    return { ok: true, messageId: res.messageId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleEmailBatch(
  batch: MessageBatch<EmailJobMessage>,
  env: ConsumerEnv
): Promise<void> {
  // Single sessionId per batch — lets admin trace which messages were
  // siblings in the same Worker invocation.
  const sessionId = crypto.randomUUID();

  if (!env.EMAIL) {
    // No binding — skip silently. Each message ack so they don't pile up
    // in the queue waiting for infrastructure that may never arrive. The
    // binding is configured in wrangler.toml so absence here means a
    // misconfigured environment (e.g., local dev without remote bindings).
    await logError(env.DB, {
      level: "warn",
      source: "mcp:email-queue",
      message: "EMAIL binding missing; acking batch without sending",
      sessionId,
      context: { batchSize: batch.messages.length },
    });
    for (const m of batch.messages) m.ack();
    return;
  }

  for (const m of batch.messages) {
    const result = await sendViaCfEmail(m.body, env.EMAIL);
    if (result.ok) {
      m.ack();
      console.log(`[queue:email] sent ${m.body.source} → ${m.body.to} (id=${result.messageId})`);
    } else {
      // Retry with a modest backoff; after max_retries=3 the message parks in
      // email-jobs-dlq (no longer dropped). Cap low so transactional mail stays
      // near-real-time on a transient blip.
      const delaySeconds = backoffSeconds(m.attempts, 10, 60); // 10, 20, 40 → cap 60
      await logError(env.DB, {
        source: "mcp:email-queue",
        message: "env.EMAIL.send failed; will retry via queue (max_retries=3, then DLQ)",
        sessionId,
        context: {
          to: m.body.to,
          subject: m.body.subject,
          messageSource: m.body.source,
          attempts: m.attempts,
          delaySeconds,
          error: result.error,
        },
      });
      m.retry({ delaySeconds });
    }
  }
}

// ─── IndexNow consumer ──────────────────────────────────────────────────

export async function handleIndexNowBatch(
  batch: MessageBatch<IndexNowMessage>,
  env: ConsumerEnv
): Promise<void> {
  // Aggregate URLs across all messages in the batch — one Bing API call
  // covers every queued ping. Track which messages contributed each URL so
  // we can audit them per-source.
  const allUrls = new Set<string>();
  const sources: Record<string, string[]> = {}; // source -> urls
  const messages = batch.messages;

  for (const m of messages) {
    const filtered = m.body.urls.filter((u) => u.startsWith(`https://${HOST}/`));
    for (const u of filtered) {
      allUrls.add(u);
      const arr = sources[m.body.source] ?? (sources[m.body.source] = []);
      if (!arr.includes(u)) arr.push(u);
    }
  }

  if (allUrls.size === 0) {
    for (const m of messages) m.ack();
    return;
  }

  if (!env.INDEXNOW_KEY) {
    await logError(env.DB, {
      level: "warn",
      source: "mcp:indexnow-queue",
      message: "INDEXNOW_KEY missing; acking batch without submitting",
      context: { batchSize: messages.length, urlCount: allUrls.size },
    });
    // Still record audit rows so the admin can see what would have been pinged.
    await recordAudit(env.DB, sources, "no_key", null, null);
    for (const m of messages) m.ack();
    return;
  }

  const urlList = Array.from(allUrls);
  const payload = {
    host: HOST,
    key: env.INDEXNOW_KEY,
    keyLocation: `https://${HOST}/${env.INDEXNOW_KEY}.txt`,
    urlList,
  };

  try {
    const res = await fetch(REPORT_API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const status = res.ok ? "success" : "failure";
    const errMsg = res.ok ? null : `HTTP ${res.status}`;
    await recordAudit(env.DB, sources, status, res.status, errMsg);

    if (res.ok) {
      for (const m of messages) m.ack();
      console.log(
        `[queue:indexnow] submitted ${urlList.length} URLs across ${messages.length} messages`
      );
    } else {
      // Bing returned non-2xx — retry the whole batch with backoff. Honor a
      // Retry-After on 429 (Bing throttling); otherwise exponential backoff
      // keyed off attempts. With max_concurrency=1 this serializes + spaces
      // retries instead of hammering Bing. 4xx burns through retries → DLQ.
      const bodyExcerpt = await res.text().catch(() => "<unreadable>");
      const maxAttempts = Math.max(...messages.map((m) => m.attempts), 1);
      const delaySeconds = retryAfterSeconds(res, 600) ?? backoffSeconds(maxAttempts, 30, 600); // 30,60,120…→cap 600
      await logError(env.DB, {
        source: "mcp:indexnow-queue",
        message: "Bing IndexNow API returned non-2xx; will retry batch (then DLQ)",
        statusCode: res.status,
        context: {
          batchSize: messages.length,
          urlCount: urlList.length,
          delaySeconds,
          bodyExcerpt: bodyExcerpt.slice(0, 500),
        },
      });
      for (const m of messages) m.retry({ delaySeconds });
    }
  } catch (error) {
    const errStr = error instanceof Error ? error.message : String(error);
    await logError(env.DB, {
      source: "mcp:indexnow-queue",
      message: "network error calling Bing IndexNow; will retry batch",
      error,
      context: { batchSize: messages.length, urlCount: allUrls.size },
    });
    await recordAudit(env.DB, sources, "failure", null, errStr);
    const maxAttempts = Math.max(...messages.map((m) => m.attempts), 1);
    const delaySeconds = backoffSeconds(maxAttempts, 30, 600);
    for (const m of messages) m.retry({ delaySeconds });
  }
}

async function recordAudit(
  database: D1Database,
  sources: Record<string, string[]>,
  status: "success" | "failure" | "no_key",
  httpStatus: number | null,
  errorMessage: string | null
): Promise<void> {
  const db = getDb(database);
  const now = new Date();
  // One audit row per source label — matches the existing per-call write
  // pattern, just batched into one transaction's worth of work.
  for (const [source, urls] of Object.entries(sources)) {
    try {
      await db.insert(indexnowSubmissions).values({
        id: crypto.randomUUID(),
        timestamp: now,
        source,
        urls: JSON.stringify(urls),
        urlCount: urls.length,
        status,
        httpStatus,
        errorMessage,
      });
    } catch (err) {
      await logError(database, {
        source: "mcp:indexnow-queue",
        message: "indexnow_submissions audit insert failed",
        error: err,
        context: { source, urlCount: urls.length, status },
      });
    }
  }
}

// ─── Discrepancy consumer ───────────────────────────────────────────────
//
// GW1.1 (2026-06-03) — drain event-discrepancies queue and write one
// event_discrepancies row per message via captureDiscrepancy.
//
// Idempotence: captureDiscrepancy has a 24-hour guard on
// (event_id, field_class, detected_by) — duplicate messages from queue
// retries write at most one row per (event, field, detected_by, day).
//
// Retry policy: max_retries=3 per the queue config. A bad-shape message
// is ack'd (not retried) so it doesn't loop forever — those are caught
// at the producer's validation step. Real D1 failures retry up to the
// queue's limit, then DLQ.
export async function handleDiscrepancyBatch(
  batch: MessageBatch<IngestDiscrepancyMessage>,
  env: ConsumerEnv
): Promise<void> {
  const db = getDb(env.DB);
  for (const m of batch.messages) {
    const msg = m.body;
    // Shape-guard: the enqueue endpoint already validates required
    // fields, but a defensive check here protects against future-
    // producer shape drift without DLQ'ing every message.
    if (
      !msg ||
      typeof msg.eventId !== "string" ||
      typeof msg.fieldClass !== "string" ||
      typeof msg.detectedBy !== "string" ||
      typeof msg.confidence !== "number"
    ) {
      await logError(env.DB, {
        level: "warn",
        source: "mcp:discrepancy-queue",
        message: "malformed message; acking without action",
        context: { attempts: m.attempts, body: msg },
      });
      m.ack();
      continue;
    }

    const id = await captureDiscrepancy(db, {
      eventId: msg.eventId,
      fieldClass: msg.fieldClass,
      detectedBy: msg.detectedBy,
      authoritativeValue: msg.authoritativeValue,
      authoritativeSourceKey: msg.authoritativeSourceKey,
      authoritativeSourceUrl: msg.authoritativeSourceUrl,
      divergentValue: msg.divergentValue,
      divergentSourceKey: msg.divergentSourceKey,
      divergentSourceUrl: msg.divergentSourceUrl,
      confidence: msg.confidence,
      notes: msg.notes,
    });

    // captureDiscrepancy returns null on idempotence skip OR on internal
    // failure (it already logged). Both are terminal for this message —
    // ack and move on. The internal-failure case will surface in
    // error_logs for monitoring; we don't want to retry-loop a poison
    // message into the DLQ when the underlying issue is e.g. an FK
    // constraint failure that won't resolve on retry.
    m.ack();
    if (id) {
      console.log(
        `[queue:discrepancy] ${msg.detectedBy} event=${msg.eventId} field=${msg.fieldClass} → ${id}`
      );
    }
  }
}
