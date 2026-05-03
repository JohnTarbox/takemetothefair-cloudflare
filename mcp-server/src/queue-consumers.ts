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

const HOST = "meetmeatthefair.com";
const REPORT_API_BASE = "https://api.indexnow.org/IndexNow";

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

type ConsumerEnv = {
  DB: D1Database;
  RESEND_API_KEY?: string;
  INDEXNOW_KEY?: string;
};

// ─── Email consumer ─────────────────────────────────────────────────────

async function sendEmailViaResend(
  msg: EmailJobMessage,
  apiKey: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const from = msg.from ?? "Meet Me at the Fair <support@meetmeatthefair.com>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "<empty>");
      return { ok: false, error: `Resend ${res.status}: ${body.slice(0, 500)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleEmailBatch(
  batch: MessageBatch<EmailJobMessage>,
  env: ConsumerEnv
): Promise<void> {
  if (!env.RESEND_API_KEY) {
    // No Resend key — skip silently. Each message ack so they don't pile up
    // in the queue waiting for a key that may never arrive.
    console.warn(
      `[queue:email] RESEND_API_KEY missing — acking ${batch.messages.length} messages without sending`
    );
    for (const m of batch.messages) m.ack();
    return;
  }

  for (const m of batch.messages) {
    const result = await sendEmailViaResend(m.body, env.RESEND_API_KEY);
    if (result.ok) {
      m.ack();
      console.warn(`[queue:email] sent ${m.body.source} → ${m.body.to}`);
    } else {
      // Retry: queue config has max_retries=3, then DLQ. Don't ack.
      console.error(`[queue:email] failed ${m.body.source} → ${m.body.to}: ${result.error}`);
      m.retry();
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
    console.warn(
      `[queue:indexnow] INDEXNOW_KEY missing — acking ${messages.length} messages, ${allUrls.size} URLs unsubmitted`
    );
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
      console.warn(
        `[queue:indexnow] submitted ${urlList.length} URLs across ${messages.length} messages`
      );
    } else {
      // Bing returned non-2xx — retry the whole batch (Cloudflare will
      // re-deliver). 4xx errors will burn through retries → DLQ.
      console.error(`[queue:indexnow] Bing returned ${res.status}, retrying batch`);
      for (const m of messages) m.retry();
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[queue:indexnow] network error: ${errMsg}`);
    await recordAudit(env.DB, sources, "failure", null, errMsg);
    for (const m of messages) m.retry();
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
      console.error("[queue:indexnow] audit insert failed:", err);
    }
  }
}
