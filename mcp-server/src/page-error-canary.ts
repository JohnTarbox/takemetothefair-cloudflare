/**
 * Issue #326 — Slack canary for page-level fetcher errors.
 *
 * What it watches
 * ---------------
 * Every page-level data fetcher in the app follows the same shape:
 *
 *     try {
 *       // ... db.select() ... return data;
 *     } catch (e) {
 *       await logError(db, { source: "app/<route>/page.tsx:<fn>", ... });
 *       return <empty default>;   // ← renders as empty state on the page
 *     }
 *
 * That default-on-error pattern means user-facing pages render byte-for-byte
 * like a real zero-match — silent failure. The 2026-06-04 D1 100-col outage
 * (PR #325 + #327) hit this pattern across `events`, `venues`, `promoters`,
 * `vendor` surfaces and burned ~16 hours before a user noticed.
 *
 * This canary polls `error_logs` every 10 minutes (piggy-backing the existing
 * `*\/10 * * * *` cron alongside the KPI recompute + inbound-email stale sweep),
 * counts entries since the last fire whose `source` matches
 * `app/%page.tsx:%`, and dispatches Slack + email alerts on:
 *
 *   - RED   — ≥ 50 errors in 10 min  (≈ 5/min sustained, outage territory)
 *   - YELLOW — ≥ 10 errors in 10 min (≈ 1/min sustained, degradation)
 *
 * Debounced via `page_error_canary_state` (one row per tier) so a single
 * sustained outage doesn't fire the same tier every cron tick:
 *
 *   - RED   debounce 30 min
 *   - YELLOW debounce 60 min
 *
 * RED bypasses the YELLOW debounce (a real outage shouldn't be muted because
 * a sub-threshold blip 40 min ago already fired YELLOW).
 *
 * Dispatch channels
 * -----------------
 * Same fan-out as the dedup-sweep canary (PR #306):
 *   - SLACK_WEBHOOK_URL_TECHNICAL — POSTs to a Slack incoming-webhook.
 *   - ALERT_EMAIL_TECHNICAL        — pushes an email-job message to
 *                                    env.EMAIL_JOBS; the queue consumer
 *                                    (this same Worker) sends via
 *                                    Cloudflare Email Sending.
 * Both are independent optional secrets. With neither set, the canary still
 * runs (computes tier, updates debounce row) but never pushes — purely
 * log-only via the persisted state.
 *
 * Per the MCP server's cron-handler convention: errors are logged via
 * logError() and swallowed — never thrown — so a single canary failure
 * doesn't trigger Cloudflare's cron retry.
 */
import { inArray } from "drizzle-orm";
import { pageErrorCanaryState } from "@takemetothefair/db-schema";
import type { Env } from "./index.js";
import { getDb } from "./db.js";
import { logError } from "./logger.js";
import { getErrorLogsBurstWindow } from "./error-logs-burst.js";

const SLACK_BUDGET_MS = 5_000;

/** The cron fires every 10 minutes; the window matches so each fire looks
 *  at the errors logged since the previous fire (no double-counting). */
const WINDOW_MINUTES = 10;

/** Source filter — every page-level fetcher writes logError with a source
 *  of `app/<path>/page.tsx:<funcName>`. SQL `LIKE 'app/%page.tsx:%'`
 *  catches all of them and is stable against new pages being added.
 *  Caveat: also catches admin pages (operator wants to know about admin
 *  breaks too — confirmed via the 2026-06-04 outage that briefly hit
 *  `app/admin/page.tsx:getRecentSubmissions`). */
const SOURCE_PATTERN = "app/%page.tsx:%";

/** Per-SOURCE tier thresholds (B2 per-source refactor, 2026-06-05).
 *  The 2026-06-04 outage drove ~42 errs/win aggregate but ~10/win per
 *  affected source (4 fetchers split the volume). Per-source thresholds:
 *  RED=10/win and YELLOW=3/win catch the same outage shape source-by-
 *  source. Lower numbers than the aggregate thresholds because a
 *  single fetcher spiking is a strong signal — global outages produce
 *  multiple separate per-source alerts which is the desired UX (you
 *  see WHICH fetchers broke). */
const RED_THRESHOLD = 10;
const YELLOW_THRESHOLD = 3;

/** Debounce — page-error state can flip on a single deploy, so these
 *  are in deploy-turnaround-time order of magnitude (not the dedup
 *  canary's 72h which matches that slow-moving signal). */
const RED_DEBOUNCE_MINUTES = 30;
const YELLOW_DEBOUNCE_MINUTES = 60;

type Tier = "RED" | "YELLOW";

/** Pure decision function — exported for unit tests. Returns the alert tier
 *  to fire, or null when below YELLOW. RED takes precedence regardless of
 *  YELLOW debounce; YELLOW respects its own debounce. */
export function decideTier(
  count: number,
  redLastAlertedAt: Date | null,
  yellowLastAlertedAt: Date | null,
  now: Date
): Tier | null {
  if (count >= RED_THRESHOLD) {
    const redCutoff = new Date(now.getTime() - RED_DEBOUNCE_MINUTES * 60_000);
    if (redLastAlertedAt == null || redLastAlertedAt < redCutoff) return "RED";
    return null;
  }
  if (count >= YELLOW_THRESHOLD) {
    const yellowCutoff = new Date(now.getTime() - YELLOW_DEBOUNCE_MINUTES * 60_000);
    if (yellowLastAlertedAt == null || yellowLastAlertedAt < yellowCutoff) return "YELLOW";
    return null;
  }
  return null;
}

/** POST a Slack message via the incoming-webhook URL. No-op if url is
 *  empty/undefined. Mirrors dedup-sweep-canary.postSlackWebhook exactly
 *  rather than refactoring to a shared helper (the two canaries are the
 *  only callers; if a third appears, extract then). */
async function postSlackWebhook(
  url: string | undefined,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  if (!url) return { ok: false, error: "no-webhook-configured" };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SLACK_BUDGET_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "<empty>");
        return { ok: false, error: `${res.status}: ${body.slice(0, 200)}` };
      }
      return { ok: true };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Main entry point. Exported for both index.ts and unit tests.
 *
 * Idempotent: re-running within a single window will just re-evaluate
 * against the same error_logs rows. The debounce state prevents
 * re-dispatching for the same outage.
 */
export async function runScheduledPageErrorCanary(env: Env): Promise<void> {
  const SOURCE = "mcp:schedule:page-error-canary";
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_MINUTES * 60_000);
  const db = getDb(env.DB);

  // 1. Count + per-source breakdown over the window.
  // B2 (2026-06-04, REL1' §0) — refactored to call the shared
  // `getErrorLogsBurstWindow` helper (B1). The helper returns the full
  // top-N source breakdown so the alert body can show *which* fetchers
  // spiked, not just the loudest one. Per-source DEBOUNCE (one alert per
  // source) is deferred: `page_error_canary_state` is keyed by tier only,
  // so per-source debounce needs a schema change. Until then the alert
  // body lists the top sources so a noisy-but-broad outage and a
  // narrow-but-deep one are visually distinguishable.
  let totalCount: number;
  let bySource: Array<{ source: string | null; count: number }>;
  try {
    const burst = await getErrorLogsBurstWindow(db, {
      since: windowStart,
      until: now,
      sourcePattern: SOURCE_PATTERN,
      // Minimum to track via this helper is YELLOW threshold; we rely on
      // the existing decideTier() to actually decide what fires.
      minCount: YELLOW_THRESHOLD,
      topSourcesLimit: 5,
    });
    totalCount = burst.totalErrors;
    bySource = burst.bySource;
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "error_logs aggregate query failed",
      error,
      sessionId,
    });
    return;
  }

  // ── 2. Per-source debounce evaluation (B2 follow-up, 2026-06-05) ──
  //
  // Was: one decideTier() on totalCount with two debounce rows (RED +
  // YELLOW). A multi-source outage debounced as one event.
  //
  // Now: load all (tier, source) debounce rows for the sources in
  // this window, then decide+dispatch per-source. Each source gets
  // its own debounce window — a localized regression on getEvents
  // and a separate one on getVenue alert independently.
  //
  // Cheap-path early-exit: if no source crosses YELLOW_THRESHOLD at
  // all (sub-3 per source), skip the debounce-state read entirely.
  const candidateSources = bySource.filter((s) => s.source && s.count >= YELLOW_THRESHOLD);
  if (candidateSources.length === 0) {
    console.log(
      `[cron] page-error-canary ok — total=${totalCount}, ` +
        `no source crossed YELLOW threshold (${YELLOW_THRESHOLD}/win) — no alert`
    );
    return;
  }

  // Load only the debounce rows for our candidate sources (avoids a
  // table-scan when most sources are silent).
  const candidateSourceNames = candidateSources.map((s) => s.source!);
  const debounceByKey = new Map<string, Date>(); // key = `${tier}::${source}`
  try {
    const stateRows = await db
      .select()
      .from(pageErrorCanaryState)
      .where(inArray(pageErrorCanaryState.source, candidateSourceNames));
    for (const row of stateRows) {
      debounceByKey.set(`${row.tier}::${row.source}`, row.lastAlertedAt);
    }
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "page_error_canary_state read failed",
      error,
      sessionId,
    });
    return;
  }

  const webhookUrl = env.SLACK_WEBHOOK_URL_TECHNICAL;
  const alertEmail = env.ALERT_EMAIL_TECHNICAL;
  let firedCount = 0;
  let skippedDebouncedCount = 0;

  for (const cs of candidateSources) {
    const src = cs.source!;
    const redLast = debounceByKey.get(`RED::${src}`) ?? null;
    const yellowLast = debounceByKey.get(`YELLOW::${src}`) ?? null;
    const tier = decideTier(cs.count, redLast, yellowLast, now);
    if (tier == null) {
      skippedDebouncedCount++;
      continue;
    }
    firedCount++;
    const emoji = tier === "RED" ? "🔴" : "🟡";

    const slackText =
      `${emoji} *Page-error canary ${tier}* — \`${src}\` got ${cs.count} errors in last ${WINDOW_MINUTES} min` +
      `\n<https://meetmeatthefair.com/admin/error-logs|Open admin/error-logs>`;

    if (webhookUrl) {
      const dispatch = await postSlackWebhook(webhookUrl, slackText);
      if (!dispatch.ok) {
        await logError(env.DB, {
          source: SOURCE,
          message: `${tier} Slack dispatch failed for ${src}: ${dispatch.error}`,
          sessionId,
          context: { tier, src, count: cs.count },
        });
      } else {
        console.log(`[cron] page-error-canary ${tier} → Slack — src=${src} count=${cs.count}`);
      }
    }

    if (alertEmail && env.EMAIL_JOBS) {
      const subject = `${emoji} Page-error canary ${tier}: ${src} (${cs.count} in ${WINDOW_MINUTES}m)`;
      const textBody =
        `${cs.count} errors on \`${src}\` in the last ${WINDOW_MINUTES} minutes.\n\n` +
        `Open admin/error-logs: https://meetmeatthefair.com/admin/error-logs\n`;
      const htmlBody =
        `<p><strong>${emoji} Page-error canary ${tier}</strong> — ${cs.count} errors on <code>${src}</code> in last ${WINDOW_MINUTES} min</p>` +
        `<p><a href="https://meetmeatthefair.com/admin/error-logs">Open admin/error-logs</a></p>`;
      try {
        await env.EMAIL_JOBS.send({
          to: alertEmail,
          subject,
          text: textBody,
          html: htmlBody,
          source: `page-error-canary:${tier.toLowerCase()}`,
        });
      } catch (error) {
        await logError(env.DB, {
          source: SOURCE,
          message: `${tier} email enqueue failed for ${src}`,
          error,
          sessionId,
          context: { tier, src, count: cs.count, alertEmail },
        });
      }
    } else if (alertEmail && !env.EMAIL_JOBS) {
      // One warn per fire would be noisy across sources; emit once
      // per cron invocation by checking firedCount.
      if (firedCount === 1) {
        await logError(env.DB, {
          level: "warn",
          source: SOURCE,
          message: "ALERT_EMAIL_TECHNICAL is set but EMAIL_JOBS queue binding is missing",
          sessionId,
        });
      }
    }

    // Upsert the per-(tier, source) debounce row.
    try {
      await db
        .insert(pageErrorCanaryState)
        .values({
          tier,
          source: src,
          lastAlertedAt: now,
          lastCount: cs.count,
        })
        .onConflictDoUpdate({
          target: [pageErrorCanaryState.tier, pageErrorCanaryState.source],
          set: { lastAlertedAt: now, lastCount: cs.count },
        });
    } catch (error) {
      await logError(env.DB, {
        source: SOURCE,
        message: `${tier} debounce row upsert failed for ${src}`,
        error,
        sessionId,
        context: { tier, src, count: cs.count },
      });
    }
  }

  if (firedCount === 0) {
    console.log(
      `[cron] page-error-canary all-debounced — ${skippedDebouncedCount} sources crossed ` +
        `but every (tier, source) within debounce window; no alert fired`
    );
  } else {
    console.log(
      `[cron] page-error-canary fired=${firedCount} debounced=${skippedDebouncedCount} ` +
        `(window=${WINDOW_MINUTES}m, total=${totalCount})`
    );
  }
}

// Exported for unit tests.
export const __test = {
  decideTier,
  postSlackWebhook,
  RED_THRESHOLD,
  YELLOW_THRESHOLD,
  RED_DEBOUNCE_MINUTES,
  YELLOW_DEBOUNCE_MINUTES,
  WINDOW_MINUTES,
  SOURCE_PATTERN,
};
