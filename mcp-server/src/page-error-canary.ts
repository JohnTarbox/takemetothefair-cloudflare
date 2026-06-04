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
import { and, gte, sql, like, desc, eq } from "drizzle-orm";
import { errorLogs, pageErrorCanaryState } from "@takemetothefair/db-schema";
import type { Env } from "./index.js";
import { getDb } from "./db.js";
import { logError } from "./logger.js";

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

/** Tier thresholds — calibrated against the 2026-06-04 outage rate
 *  (~250 errs/hr aggregate during the broken state ≈ 42 per 10-min window). */
const RED_THRESHOLD = 50;
const YELLOW_THRESHOLD = 10;

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

  // 1. Count + top-source aggregate over the window.
  let totalCount: number;
  let topSource: { source: string | null; count: number } | null;
  try {
    // Total errors matching the page-fetcher pattern in the window.
    const [totalRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(errorLogs)
      .where(
        and(
          gte(errorLogs.timestamp, windowStart),
          like(errorLogs.source, SOURCE_PATTERN),
          eq(errorLogs.level, "error")
        )
      );
    totalCount = totalRow?.count ?? 0;

    // Top-source by count (single row) for triage context in the alert.
    // Only run if we have a non-trivial signal — saves a SELECT on the
    // (very common) zero-error fire path.
    if (totalCount > 0) {
      const topRows = await db
        .select({ source: errorLogs.source, count: sql<number>`count(*)` })
        .from(errorLogs)
        .where(
          and(
            gte(errorLogs.timestamp, windowStart),
            like(errorLogs.source, SOURCE_PATTERN),
            eq(errorLogs.level, "error")
          )
        )
        .groupBy(errorLogs.source)
        .orderBy(desc(sql`count(*)`))
        .limit(1);
      topSource = topRows[0] ?? null;
    } else {
      topSource = null;
    }
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "error_logs aggregate query failed",
      error,
      sessionId,
    });
    return;
  }

  // 2. Load current debounce state for both tiers.
  let redLastAlertedAt: Date | null = null;
  let yellowLastAlertedAt: Date | null = null;
  try {
    const stateRows = await db.select().from(pageErrorCanaryState);
    for (const row of stateRows) {
      if (row.tier === "RED") redLastAlertedAt = row.lastAlertedAt;
      else if (row.tier === "YELLOW") yellowLastAlertedAt = row.lastAlertedAt;
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

  const tier = decideTier(totalCount, redLastAlertedAt, yellowLastAlertedAt, now);

  if (tier == null) {
    // No-op: either below YELLOW threshold or debounced. Log briefly so
    // wrangler tail shows the cron is alive even on green fires.
    console.log(
      `[cron] page-error-canary ok — count=${totalCount} (window=${WINDOW_MINUTES}m, ` +
        `red_last=${redLastAlertedAt?.toISOString() ?? "n/a"}, ` +
        `yellow_last=${yellowLastAlertedAt?.toISOString() ?? "n/a"}) — no alert`
    );
    return;
  }

  // 3. Build alert + dispatch.
  const emoji = tier === "RED" ? "🔴" : "🟡";
  const topDetail = topSource?.source
    ? ` · top source: \`${topSource.source}\` (${topSource.count})`
    : "";
  const slackText =
    `${emoji} *Page-error canary ${tier}* — ${totalCount} errors in last ${WINDOW_MINUTES} min` +
    `${topDetail}\n<https://meetmeatthefair.com/admin/error-logs|Open admin/error-logs>`;

  const webhookUrl = env.SLACK_WEBHOOK_URL_TECHNICAL;
  if (webhookUrl) {
    const dispatch = await postSlackWebhook(webhookUrl, slackText);
    if (!dispatch.ok) {
      await logError(env.DB, {
        source: SOURCE,
        message: `${tier} Slack dispatch failed: ${dispatch.error}`,
        sessionId,
        context: { tier, totalCount, topSource: topSource?.source ?? null },
      });
    } else {
      console.log(
        `[cron] page-error-canary ${tier} → Slack — count=${totalCount} top=${topSource?.source ?? "n/a"}`
      );
    }
  }

  const alertEmail = env.ALERT_EMAIL_TECHNICAL;
  if (alertEmail && env.EMAIL_JOBS) {
    const subject = `${emoji} Page-error canary ${tier}: ${totalCount} errors in ${WINDOW_MINUTES} min`;
    const textBody =
      `${totalCount} errors matching source LIKE '${SOURCE_PATTERN}' in the last ${WINDOW_MINUTES} minutes.\n\n` +
      (topSource?.source ? `Top source: ${topSource.source} (${topSource.count})\n\n` : "") +
      `Open admin/error-logs: https://meetmeatthefair.com/admin/error-logs\n`;
    const htmlBody =
      `<p><strong>${emoji} Page-error canary ${tier}</strong> — ${totalCount} errors in last ${WINDOW_MINUTES} min</p>` +
      (topSource?.source
        ? `<p>Top source: <code>${topSource.source}</code> (${topSource.count})</p>`
        : "") +
      `<p><a href="https://meetmeatthefair.com/admin/error-logs">Open admin/error-logs</a></p>`;
    try {
      await env.EMAIL_JOBS.send({
        to: alertEmail,
        subject,
        text: textBody,
        html: htmlBody,
        source: `page-error-canary:${tier.toLowerCase()}`,
      });
      console.log(`[cron] page-error-canary ${tier} → email queued — ${alertEmail}`);
    } catch (error) {
      await logError(env.DB, {
        source: SOURCE,
        message: `${tier} email enqueue failed`,
        error,
        sessionId,
        context: { tier, totalCount, alertEmail },
      });
    }
  } else if (alertEmail && !env.EMAIL_JOBS) {
    await logError(env.DB, {
      level: "warn",
      source: SOURCE,
      message: "ALERT_EMAIL_TECHNICAL is set but EMAIL_JOBS queue binding is missing",
      sessionId,
    });
  }

  if (!webhookUrl && !alertEmail) {
    console.log(
      `[cron] page-error-canary ${tier} — no push channels configured (debounce row still written); ` +
        `count=${totalCount}`
    );
  }

  // 4. Upsert the debounce row for this tier.
  try {
    await db
      .insert(pageErrorCanaryState)
      .values({
        tier,
        lastAlertedAt: now,
        lastCount: totalCount,
        lastTopSource: topSource?.source ?? null,
        lastTopCount: topSource?.count ?? null,
      })
      .onConflictDoUpdate({
        target: pageErrorCanaryState.tier,
        set: {
          lastAlertedAt: now,
          lastCount: totalCount,
          lastTopSource: topSource?.source ?? null,
          lastTopCount: topSource?.count ?? null,
        },
      });
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: `${tier} debounce row upsert failed`,
      error,
      sessionId,
      context: { tier, totalCount },
    });
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
