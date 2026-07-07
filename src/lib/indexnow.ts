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

import {
  indexnowSubmissions,
  indexnowUrlLastSuccess,
  pendingSearchPings,
  timeToIndexLog,
} from "@/lib/db/schema";
import { inArray, lt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { SITE_HOSTNAME } from "@takemetothefair/constants";
import { getCloudflareRateLimitKv, getCloudflareEnv } from "@/lib/cloudflare";
import {
  armIndexNowCooldown,
  checkIndexNowBreaker,
  clearIndexNowCooldown,
  AUTO_PAUSE_AFTER_429_STREAK,
  AUTO_PAUSE_REASON,
} from "@/lib/indexnow-breaker";
import { sendEmail } from "@/lib/email/send";
import { logError } from "@/lib/logger";

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

// OPE-73 — stale-pause health signal. A manual/auto pause is meant to be quiet
// for ≥24–48h so Bing's penalty decays; but a pause left engaged for far longer
// silently stops ALL indexing (this ticket: a manual pause sat for ~2 weeks and
// only surfaced as hourly 502 noise). Once a pause exceeds this age, re-surface
// it — throttled — so a forgotten kill-switch doesn't sit silent again.
const STALE_PAUSE_MS = 72 * 60 * 60 * 1000; // 3 days
const STALE_ALERT_KEY = "indexnow:stale_pause_alerted_at";
const STALE_ALERT_THROTTLE_MS = 24 * 60 * 60 * 1000; // at most one re-alert/day

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

type SubmissionStatus =
  | "success"
  | "failure"
  | "no_key"
  | "no_eligible_urls"
  | "skipped"
  // REL7 — URL pinged successfully within the suppression window; not re-sent.
  | "suppressed_dedup";

// REL7 same-URL de-dup window. A URL that returned 2xx from Bing within this
// span is suppressed on subsequent pings (unless content changes — v2). 24h per
// John's spec; long enough to break the deferred-queue re-arm loop, short enough
// that a genuinely-stale page still re-pings daily.
const SUPPRESS_WINDOW_MS = 24 * 60 * 60 * 1000;

// D1 binds one variable per parameter and caps a statement at ~100. The deferred
// flush can carry ~120 URLs, so chunk the inArray read well under the limit.
const SUPPRESS_QUERY_CHUNK = 90;

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
 * REL7 suppression read — partition `urls` into those that were pinged
 * successfully within SUPPRESS_WINDOW_MS (suppress) and the rest (eligible).
 * Reads indexnow_url_last_success in ≤90-URL chunks to respect D1's variable cap.
 * Fails OPEN: any read error treats every URL as eligible so a flaky KV/D1 read
 * never silently blocks indexing.
 */
async function partitionBySuppression(
  db: NonNullable<Db>,
  urls: string[],
  now: Date
): Promise<{ eligible: string[]; suppressed: string[] }> {
  try {
    const lastByUrl = new Map<string, Date>();
    for (let i = 0; i < urls.length; i += SUPPRESS_QUERY_CHUNK) {
      const chunk = urls.slice(i, i + SUPPRESS_QUERY_CHUNK);
      const rows = await db
        .select({
          url: indexnowUrlLastSuccess.url,
          lastSuccessAt: indexnowUrlLastSuccess.lastSuccessAt,
        })
        .from(indexnowUrlLastSuccess)
        .where(inArray(indexnowUrlLastSuccess.url, chunk));
      for (const r of rows) {
        if (r.lastSuccessAt) lastByUrl.set(r.url, r.lastSuccessAt);
      }
    }
    const eligible: string[] = [];
    const suppressed: string[] = [];
    for (const u of urls) {
      const last = lastByUrl.get(u);
      if (last && now.getTime() - last.getTime() < SUPPRESS_WINDOW_MS) {
        suppressed.push(u);
      } else {
        eligible.push(u);
      }
    }
    return { eligible, suppressed };
  } catch (err) {
    console.error("[IndexNow] suppression read failed — treating all URLs as eligible:", err);
    return { eligible: urls, suppressed: [] };
  }
}

/**
 * REL7 success write — upsert the per-URL last-success timestamp after a 2xx
 * Bing submission so future pings within the window are suppressed. Per-URL loop
 * (batches here are ≤ the deferred flush size); never throws.
 */
async function recordIndexNowSuccess(db: Db, urls: string[], at: Date): Promise<void> {
  if (!db || urls.length === 0) return;
  try {
    for (const url of urls) {
      await db
        .insert(indexnowUrlLastSuccess)
        .values({ url, lastSuccessAt: at, contentHash: null, updatedAt: at })
        .onConflictDoUpdate({
          target: indexnowUrlLastSuccess.url,
          set: { lastSuccessAt: at, updatedAt: at },
        });
    }
  } catch (err) {
    console.error("[IndexNow] Failed to record per-URL last-success:", err);
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

/** REL6: read a runtime env var via CF bindings; falls back to process.env for
 *  local/dev. Mirrors the kpi-alerts pattern. */
function getRuntimeEnv(key: string): string | undefined {
  try {
    const env = getCloudflareEnv() as unknown as Record<string, string | undefined>;
    return env[key];
  } catch {
    return process.env[key];
  }
}

/**
 * REL6: fire the operator alert when the breaker auto-pauses IndexNow. Sends to
 * ALERT_EMAIL_TECHNICAL (the same technical channel the KPI alerts use). If
 * that's unset, logs a warning instead of silently dropping the signal —
 * either way the pause is already engaged in KV. Never throws.
 */
async function sendIndexNowAutoPauseAlert(db: Db, consec: number): Promise<void> {
  const text = [
    `IndexNow has been AUTO-PAUSED after ${consec} consecutive 429 responses from Bing`,
    `(threshold: ${AUTO_PAUSE_AFTER_429_STREAK}) with no successful (2xx) submission in between.`,
    ``,
    `The kill-switch "indexnow:paused" is now set in RATE_LIMIT_KV. No IndexNow`,
    `pings will be sent (create paths still queue deferred rows) until an operator`,
    `clears it — this latch does NOT self-heal by design, because auto-resuming`,
    `just re-arms Bing's sticky per-host penalty.`,
    ``,
    `Before clearing, confirm Bing's penalty has decayed (a quiet window of`,
    `≥24–48h is typical). To resume:`,
    ``,
    `  wrangler kv key delete --namespace-id b7aeca316e7a41108fd375be2e152cff indexnow:paused --remote`,
    ``,
    `Then backfill any queued URLs via the resubmit_indexnow MCP tool.`,
  ].join("\n");

  const to = getRuntimeEnv("ALERT_EMAIL_TECHNICAL");
  if (!to) {
    await logError(db, {
      level: "warn",
      source: "indexnow:auto-pause",
      message: `IndexNow auto-paused (consec=${consec}) but ALERT_EMAIL_TECHNICAL is unset — no email sent`,
    });
    return;
  }
  await sendEmail(db, {
    to,
    subject: "🚨 IndexNow auto-paused after a sustained Bing 429 streak",
    text,
    html: `<p>${text.replace(/\n/g, "<br>")}</p>`,
    source: "indexnow:auto-pause",
  });
}

/**
 * OPE-73 — re-surface a STALE pause. When the breaker has been paused past
 * STALE_PAUSE_MS, emit a throttled warn log (and, if configured, an operator
 * email) so a forgotten kill-switch resurfaces instead of sitting silent. The
 * pause set-time is parsed from the breaker note (the admin/analytics pause and
 * the auto-latch both stamp an ISO timestamp); if it can't be parsed we stay
 * quiet (fail safe). Best-effort throughout — never throws, never blocks the
 * skip path, fails open on any KV error.
 */
async function maybeAlertStalePause(
  db: Db,
  kv: Parameters<typeof checkIndexNowBreaker>[0],
  breaker: Awaited<ReturnType<typeof checkIndexNowBreaker>>
): Promise<void> {
  try {
    if (!kv || breaker.reason !== "paused") return; // cooldowns are short by design
    const m = (breaker.note ?? "").match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
    if (!m) return; // unknown age → don't alert
    const pausedAt = new Date(m[1]).getTime();
    if (Number.isNaN(pausedAt)) return;
    const ageMs = Date.now() - pausedAt;
    if (ageMs < STALE_PAUSE_MS) return; // legitimate short pause — stay quiet

    const last = await kv.get(STALE_ALERT_KEY);
    if (last && Date.now() - Number(last) < STALE_ALERT_THROTTLE_MS) return; // throttled
    await kv.put(STALE_ALERT_KEY, String(Date.now()), { expirationTtl: 60 * 60 * 48 });

    const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    const msg =
      `IndexNow has been PAUSED for ~${days}d (since ${m[1]}) — 0 URLs submitted to Bing in ` +
      `that window. If Bing's per-host penalty has decayed, clear the kill-switch ` +
      `(kv delete indexnow:paused) and backfill via the resubmit_indexnow tool; otherwise ` +
      `this is expected. This is a throttled reminder (≤1/day), not a new failure.`;
    await logError(db, { level: "warn", source: "indexnow:health", message: msg });

    const to = getRuntimeEnv("ALERT_EMAIL_TECHNICAL");
    if (to) {
      await sendEmail(db, {
        to,
        subject: `⚠️ IndexNow still paused after ~${days} days`,
        text: msg,
        html: `<p>${msg}</p>`,
        source: "indexnow:health",
      });
    }
  } catch {
    // Fail open — health alerting must never break (or block) indexing.
  }
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
  let filtered = list
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

  // REL7 same-URL de-dup suppressor — sits ABOVE the kill-switch + breaker.
  // Drop any URL pinged successfully within the last 24h so the deferred queue
  // can't re-ram Bing with an identical URL set on every un-pause (the exact
  // failure that survived REL4 recovery attempts #1 and #2). Suppressed URLs are
  // recorded as a distinct status for the daily aggregate; the breaker and Bing
  // only ever see the eligible remainder. Fails open (partition swallows errors).
  if (db) {
    const { eligible, suppressed } = await partitionBySuppression(db, filtered, new Date());
    if (suppressed.length > 0) {
      await recordSubmission(db, source, suppressed, "suppressed_dedup", null, "rel7_24h_dedup");
    }
    filtered = eligible;
    if (filtered.length === 0) {
      // Everything was suppressed — nothing attempted against Bing. ok:true so a
      // flush marks its rows drained (they were already indexed within the window).
      return {
        ok: true,
        deferred: false,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        httpStatus: null,
        failureReason: null,
      };
    }
  }

  // REL4 circuit breaker — the single choke point where Bing is actually
  // contacted. If an operator paused IndexNow, or a prior 429 armed a cooldown,
  // skip the submission entirely (no Bing contact) and surface ok:false so the
  // flush leaves its rows pending for a later cron instead of dropping them.
  // Deferred enqueues happen ABOVE this guard, so create paths still queue
  // normally while we wait out Bing's penalty. Fails open if KV is unavailable.
  const kv = getCloudflareRateLimitKv();
  const breaker = await checkIndexNowBreaker(kv);
  if (breaker.blocked) {
    // REL6: record a DISTINCT status for the auto-429-streak latch vs a manual
    // operator kill-switch (both surface reason "paused"), so the daily
    // aggregate can tell "Bing penalized us and we latched" apart from "an
    // operator paused us". Cooldown stays its own timestamped reason.
    const reason =
      breaker.reason === "paused"
        ? breaker.note?.startsWith(AUTO_PAUSE_REASON)
          ? AUTO_PAUSE_REASON
          : "breaker_paused"
        : `breaker_cooldown_until_${breaker.until ? new Date(breaker.until).toISOString() : "?"}`;
    console.warn(
      `[IndexNow] circuit breaker open (${reason}) — skipping ${filtered.length} URL(s)`
    );
    await recordSubmission(db, source, filtered, "skipped", null, reason);
    // OPE-73: a breaker skip is a clean DEFERRAL, not a submission failure —
    // Bing was never contacted and the rows stay queued for a later cron. Mark
    // `deferred` so the /api/internal/indexnow endpoint (503, not 502) and the
    // MCP flush treat it as "leave pending, don't log an error" instead of the
    // hourly 502 noise that hid a 2-week-old pause. `failed:0` — nothing failed.
    await maybeAlertStalePause(db, kv, breaker);
    return {
      ok: false,
      deferred: true,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      httpStatus: null,
      failureReason: reason,
    };
  }

  const submittedAt = new Date();
  let succeeded = 0;
  let failed = 0;
  let lastHttpStatus: number | null = null;
  let lastFailureReason: string | null = null;
  let lastRetryAfterMs: number | null = null;

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
        await recordIndexNowSuccess(db, filtered, submittedAt);
      } else {
        failed = 1;
        lastHttpStatus = response.status;
        lastFailureReason = body || `HTTP ${response.status}`;
        if (response.status === 429) {
          lastRetryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        }
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
          await recordIndexNowSuccess(db, chunk, submittedAt);
        } else {
          failed += chunk.length;
          lastHttpStatus = response.status;
          lastFailureReason = body || `HTTP ${response.status}`;
          if (response.status === 429) {
            lastRetryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
          }
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

  // REL4 breaker bookkeeping — a 429 (re)arms the escalating cooldown so every
  // path stops contacting a throttled host; a clean batch clears it so normal
  // service resumes immediately. Network errors (caught above) deliberately
  // leave the cooldown untouched: a transient fetch failure isn't a throttle.
  if (lastHttpStatus === 429) {
    const arm = await armIndexNowCooldown(kv, lastRetryAfterMs);
    // REL6: the breaker just auto-engaged the operator kill-switch after a
    // sustained 429 streak. Email a human exactly once (autoPaused is true on
    // only the transitioning call). NO self-heal — the operator un-pauses.
    if (arm.autoPaused) {
      await sendIndexNowAutoPauseAlert(db, arm.consec);
    }
  } else if (failed === 0) {
    await clearIndexNowCooldown(kv);
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
  kind: "events" | "venues" | "vendors" | "promoters" | "blog" | "performers",
  slug: string
): string {
  return `https://${HOST}/${kind}/${slug}`;
}
