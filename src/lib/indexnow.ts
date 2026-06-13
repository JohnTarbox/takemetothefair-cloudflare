/**
 * IndexNow protocol — instant URL submission to participating search engines
 * (Bing, Yandex, Seznam, Naver). Single endpoint, fire-and-forget.
 *
 * Spec: https://www.indexnow.org/documentation
 *
 * Set INDEXNOW_KEY as a Cloudflare Worker secret. The key file is served at
 * the SITE ROOT (https://meetmeatthefair.com/<key>.txt) by
 * src/app/[indexnowKey]/route.ts. Root location matters: per the spec, a key
 * file's path scope authorizes only URLs under that path. Serving from a
 * subdirectory (e.g. /api/indexnow-key/) caused IndexNow to reject all
 * /blog/, /events/, /venues/ submissions with HTTP 422.
 *
 * NEVER throws to the caller. Logs success/failure to console for wrangler
 * tail observability AND persists every attempt to the indexnow_submissions
 * table for the /admin/analytics → IndexNow tab.
 */

import { indexnowSubmissions, pendingSearchPings, timeToIndexLog } from "@/lib/db/schema";
import { lt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { SITE_HOSTNAME } from "@takemetothefair/constants";

const HOST = SITE_HOSTNAME;
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const MAX_BATCH_SIZE = 10_000;

// Bing's IndexNow endpoint enforces a per-host burst limit (~1 req/sec). When
// several deletes/updates fire in parallel (e.g. duplicate-vendor cleanup),
// the slower requests come back 429. Total fallback backoff budget here is
// ≤ 3.5s per chunk (500 + 1000 + 2000 ms), so we stay well under the Worker
// 30s cap even when several chunks hit the limit in sequence.
const RETRY_DELAYS_MS = [500, 1000, 2000];

// REL4 (2026-06-13) — when Bing 429s it may send a `Retry-After` telling us how
// long its per-host cooldown runs. Operator testing showed those windows can be
// ~15 min — far longer than we can sleep inside a 30s-capped Worker. So we honor
// Retry-After only up to this in-request budget; a longer cooldown means we give
// up retrying NOW and surface the 429, so the caller (the flush) leaves its rows
// pending for a later cron rather than re-firing into the storm.
const MAX_RETRY_AFTER_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse an HTTP `Retry-After` header into milliseconds-from-now. Supports both
 * the delta-seconds form (`Retry-After: 120`) and the HTTP-date form
 * (`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`). Returns null when absent or
 * unparseable so the caller falls back to fixed exponential backoff.
 */
export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

async function fetchWithRetryOn429(
  url: string,
  init: RequestInit & { method?: string }
): Promise<Response> {
  let response = await fetch(url, init);
  for (const fallbackDelay of RETRY_DELAYS_MS) {
    if (response.status !== 429) return response;
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    // Cooldown longer than our budget → stop retrying and let the 429 stand.
    // Re-firing now would just add to the burst; leaving the work pending for
    // the next flush/cron honors the cooldown without burning the Worker.
    if (retryAfterMs !== null && retryAfterMs > MAX_RETRY_AFTER_MS) return response;
    await sleep(retryAfterMs ?? fallbackDelay);
    response = await fetch(url, init);
  }
  return response;
}

function keyLocation(key: string): string {
  return `https://${HOST}/${key}.txt`;
}

interface IndexNowEnv {
  INDEXNOW_KEY?: string;
}

type Db = DrizzleD1Database<Record<string, unknown>> | null;

type SubmissionStatus = "success" | "failure" | "no_key" | "no_eligible_urls";

async function recordSubmission(
  db: Db,
  source: string,
  urls: string[],
  status: SubmissionStatus,
  httpStatus: number | null,
  errorMessage: string | null
): Promise<void> {
  if (!db) return;
  try {
    await db.insert(indexnowSubmissions).values({
      timestamp: new Date(),
      source,
      urls: JSON.stringify(urls),
      urlCount: urls.length,
      status,
      httpStatus: httpStatus ?? undefined,
      errorMessage: errorMessage ?? undefined,
    });

    // 1% probabilistic cleanup of submissions older than 30 days
    if (Math.random() < 0.01) {
      const thirtyDaysAgo = new Date(Date.now() - 2592000 * 1000);
      await db.delete(indexnowSubmissions).where(lt(indexnowSubmissions.timestamp, thirtyDaysAgo));
    }
  } catch (err) {
    // Never throw from the logger
    console.error("[IndexNow] Failed to persist submission record:", err);
  }
}

/**
 * §10.2 time-to-index seed: write one row per submitted URL into
 * time_to_index_log so the reconciler sweep can pair the submission against
 * the next gscInspectionState.lastCrawlTime > submission_at.
 *
 * Fire-and-forget; surfaced via the §10.3 "Time-to-index median" widget.
 */
async function recordTimeToIndexSeed(db: Db, urls: string[], submittedAt: Date): Promise<void> {
  if (!db || urls.length === 0) return;
  try {
    const targetFromUrl = (u: string): { type: string | null; id: string | null } => {
      // URL shape: https://meetmeatthefair.com/{kind}/{slug}
      const m = u.match(/\/(events|venues|vendors|promoters|blog)\/([^/?#]+)/);
      if (!m) return { type: null, id: null };
      return { type: m[1].replace(/s$/, ""), id: m[2] };
    };
    const rows = urls.map((url) => {
      const t = targetFromUrl(url);
      return {
        url,
        targetType: t.type,
        targetId: t.id,
        indexnowSubmittedAt: submittedAt,
        firstCrawlAt: null,
        lagSeconds: null,
        computedAt: submittedAt,
      };
    });
    // INSERT OR IGNORE semantics via try/catch on the unique (url, submittedAt)
    // index — duplicate seeds (same url + same instant) are no-ops.
    for (const row of rows) {
      try {
        await db.insert(timeToIndexLog).values(row);
      } catch {
        /* duplicate seed — ignore */
      }
    }
  } catch (err) {
    console.error("[IndexNow] Failed to seed time_to_index_log:", err);
  }
}

/**
 * Defer hook for bulk-ingest paths. When the caller wants to batch the
 * IndexNow call across many entity writes, pass `opts.defer: true` plus the
 * entity metadata; the function queues a row in `pending_search_pings`
 * instead of firing the ping inline. flush_pending_search_pings (MCP admin
 * tool) or the MCP server's hourly cron drains the outbox into one batched
 * submit. If db or entity metadata is missing, the deferral falls through
 * to inline — callers don't have to thread args perfectly at every site.
 */
export interface DeferEntity {
  type: "vendor" | "venue" | "event" | "promoter" | "blog";
  id: string;
  slug: string;
  action: "create" | "update" | "status_change";
}

async function enqueueDeferredPing(db: NonNullable<Db>, entity: DeferEntity): Promise<void> {
  await db.insert(pendingSearchPings).values({
    entityType: entity.type,
    entityId: entity.id,
    entitySlug: entity.slug,
    action: entity.action,
    queuedAt: new Date(),
  });
}

/**
 * Outcome of a ping attempt. REL4 (2026-06-13): `pingIndexNow` used to return
 * `void`, which erased the true Bing status — the internal endpoint then always
 * reported success and the MCP flush marked its outbox rows flushed even on a
 * 429, silently dropping every URL in the batch. Callers that need to know
 * whether the URLs actually landed (the flush, the internal endpoint) read
 * `ok`; fire-and-forget inline callers ignore the return value as before.
 *
 * `ok` is true iff every attempted Bing submission returned 2xx. A deferred
 * enqueue is `ok:true, deferred:true` (nothing was rejected). `no_key` is
 * `ok:false` so a misconfigured key leaves flush rows pending rather than
 * silently consuming them; `no_eligible_urls` is `ok:true` (nothing to send).
 */
export interface PingResult {
  ok: boolean;
  deferred: boolean;
  attempted: number;
  succeeded: number;
  failed: number;
  /** Last non-2xx Bing status observed (e.g. 429), or null on network error / nothing sent. */
  httpStatus: number | null;
  /** Short reason when !ok: a status string, body excerpt, "no_key", or error message. */
  failureReason: string | null;
}

export async function pingIndexNow(
  db: Db,
  urls: string | string[],
  env: IndexNowEnv,
  source: string,
  opts?: { defer?: boolean; entity?: DeferEntity }
): Promise<PingResult> {
  const key = env.INDEXNOW_KEY;
  const list = Array.isArray(urls) ? urls : [urls];
  const filtered = list
    .map((u) => u?.trim())
    .filter((u): u is string => Boolean(u && u.startsWith(`https://${HOST}/`)));

  // Deferred path — write outbox row and return. Failures here log + fall
  // through to inline so a misconfigured caller still gets indexed.
  if (opts?.defer && db && opts.entity) {
    try {
      await enqueueDeferredPing(db, opts.entity);
      return {
        ok: true,
        deferred: true,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        httpStatus: null,
        failureReason: null,
      };
    } catch (err) {
      console.error("[IndexNow defer] enqueue failed, falling through to inline:", err);
    }
  }

  if (!key) {
    console.warn("[IndexNow] INDEXNOW_KEY not configured — skipping ping");
    await recordSubmission(db, source, filtered, "no_key", null, null);
    return {
      ok: false,
      deferred: false,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      httpStatus: null,
      failureReason: "no_key",
    };
  }

  if (filtered.length === 0) {
    await recordSubmission(db, source, [], "no_eligible_urls", null, null);
    return {
      ok: true,
      deferred: false,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      httpStatus: null,
      failureReason: "no_eligible_urls",
    };
  }

  const submittedAt = new Date();
  let succeeded = 0;
  let failed = 0;
  let lastHttpStatus: number | null = null;
  let lastFailureReason: string | null = null;

  try {
    if (filtered.length === 1) {
      const qs = new URLSearchParams({
        url: filtered[0],
        key,
        keyLocation: keyLocation(key),
      });
      const response = await fetchWithRetryOn429(`${INDEXNOW_ENDPOINT}?${qs.toString()}`, {
        method: "GET",
      });
      const body = response.ok ? "" : (await response.text()).slice(0, 200);
      console.log(`[IndexNow] GET ${filtered[0]} → ${response.status}${body ? " " + body : ""}`);
      await recordSubmission(
        db,
        source,
        filtered,
        response.ok ? "success" : "failure",
        response.status,
        response.ok ? null : body || `HTTP ${response.status}`
      );
      if (response.ok) {
        succeeded = 1;
        await recordTimeToIndexSeed(db, filtered, submittedAt);
      } else {
        failed = 1;
        lastHttpStatus = response.status;
        lastFailureReason = body || `HTTP ${response.status}`;
      }
    } else {
      // Batch up to MAX_BATCH_SIZE per request
      for (let i = 0; i < filtered.length; i += MAX_BATCH_SIZE) {
        const chunk = filtered.slice(i, i + MAX_BATCH_SIZE);
        const response = await fetchWithRetryOn429(INDEXNOW_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            host: HOST,
            key,
            keyLocation: keyLocation(key),
            urlList: chunk,
          }),
        });
        const body = response.ok ? "" : (await response.text()).slice(0, 200);
        console.log(
          `[IndexNow] POST ${chunk.length} URLs → ${response.status}${body ? " " + body : ""}`
        );
        await recordSubmission(
          db,
          source,
          chunk,
          response.ok ? "success" : "failure",
          response.status,
          response.ok ? null : body || `HTTP ${response.status}`
        );
        if (response.ok) {
          succeeded += chunk.length;
          await recordTimeToIndexSeed(db, chunk, submittedAt);
        } else {
          failed += chunk.length;
          lastHttpStatus = response.status;
          lastFailureReason = body || `HTTP ${response.status}`;
        }
      }
    }
  } catch (error) {
    console.error("[IndexNow] Network error:", error);
    const message = error instanceof Error ? error.message : String(error);
    await recordSubmission(db, source, filtered, "failure", null, message);
    return {
      ok: false,
      deferred: false,
      attempted: filtered.length,
      succeeded: 0,
      failed: filtered.length,
      httpStatus: null,
      failureReason: message,
    };
  }

  return {
    ok: failed === 0,
    deferred: false,
    attempted: filtered.length,
    succeeded,
    failed,
    httpStatus: lastHttpStatus,
    failureReason: failed === 0 ? null : lastFailureReason,
  };
}

/** Construct the canonical public URL for a content slug. */
export function indexNowUrlFor(
  kind: "events" | "venues" | "vendors" | "promoters" | "blog",
  slug: string
): string {
  return `https://${HOST}/${kind}/${slug}`;
}
