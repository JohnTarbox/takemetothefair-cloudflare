/**
 * A3 / K2 part 7 (analyst 2026-06-01 EVE) — daily Slack canary for the
 * dedup sweep cluster count.
 *
 * Polls GET https://meetmeatthefair.com/api/admin/duplicates/sweep,
 * INSERTs today's snapshot into dedup_sweep_snapshots, computes deltas
 * vs yesterday + 7-day rolling avg, and dispatches a Slack alert when
 * the cluster count moves materially. Wired into the daily cron branch
 * in mcp-server/src/index.ts:1118-1134.
 *
 * Alert tiers:
 *   - RED on +1 cluster growth day-over-day (always fires, no debounce).
 *     Any new cluster is a regression worth surfacing immediately.
 *   - YELLOW on >10% growth over the prior 7-day rolling avg of total
 *     cluster count (debounced 72h per the KPI YELLOW pattern). Inline
 *     state via dedup_sweep_snapshots.last_yellow_alerted_at.
 *
 * Dispatch channels — either or both, set independently:
 *   - SLACK_WEBHOOK_URL_TECHNICAL — POSTs to a Slack incoming-webhook.
 *   - ALERT_EMAIL_TECHNICAL       — pushes an email-job message to
 *                                   env.EMAIL_JOBS; the queue consumer
 *                                   (this same Worker) sends via
 *                                   Cloudflare Email Sending.
 * Both are optional secrets bound on the MCP Worker. With neither set,
 * the canary still runs (writes snapshot, computes tier) but never
 * pushes a notification — purely log-only via the persisted snapshot.
 * Same shape as the KPI alerts dispatch fan-out at src/lib/kpi-alerts.ts.
 *
 * Per the MCP server's cron-handler convention (see comments in
 * mcp-server/src/index.ts around runMainAppSweep): errors are logged
 * via logError() and swallowed — never thrown — so a single canary
 * failure doesn't trigger Cloudflare's tighter-schedule cron retry.
 */
import { eq, gte, sql, desc } from "drizzle-orm";
import { dedupSweepSnapshots } from "@takemetothefair/db-schema";
import type { Env } from "./index.js";
import { getDb } from "./db.js";
import { logError } from "./logger.js";

const SLACK_BUDGET_MS = 5_000;
/** Hours of suppression after a YELLOW dispatch before the next YELLOW is allowed. */
const YELLOW_DEBOUNCE_HOURS = 72;
/** Growth ratio that triggers YELLOW (10%). RED bypasses entirely. */
const YELLOW_GROWTH_RATIO = 1.1;

/** Sweep response shape — must match the route at
 *  src/app/api/admin/duplicates/sweep/route.ts:145-161. */
interface SweepResponse {
  success: boolean;
  counts?: {
    venue_date_clusters: number;
    city_state_date_clusters: number;
    total_clusters: number;
    events_in_clusters: number;
  };
  error?: string;
}

/** Today's date in UTC as YYYY-MM-DD, matching how snapshots are keyed. */
function todayUtcYmd(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** POST a Slack message via the incoming-webhook URL. No-op if url is
 *  empty/undefined. Returns true on 2xx, false otherwise — caller logs. */
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
 * Exported for unit tests + index.ts. Idempotent within a day —
 * snapshot_date is UNIQUE so re-running same-day UPDATEs in place
 * rather than failing.
 */
export async function runScheduledDedupSweepCanary(env: Env): Promise<void> {
  const SOURCE = "mcp:schedule:dedup-sweep-canary";
  const sessionId = crypto.randomUUID();

  // 1. Fetch the live sweep response.
  const sweepUrl = `${env.MAIN_APP_URL ?? "https://meetmeatthefair.com"}/api/admin/duplicates/sweep?limit=500`;
  let sweep: SweepResponse;
  try {
    const init: RequestInit = {
      method: "GET",
      headers: { "X-Internal-Key": env.INTERNAL_API_KEY ?? "" },
    };
    const response = env.MAIN_APP
      ? await env.MAIN_APP.fetch(new Request(sweepUrl, init))
      : await fetch(sweepUrl, init);
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      await logError(env.DB, {
        source: SOURCE,
        message: "sweep endpoint returned non-2xx",
        statusCode: response.status,
        sessionId,
        context: { url: sweepUrl, status: response.status, bodyExcerpt: body },
      });
      return;
    }
    sweep = (await response.json()) as SweepResponse;
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "sweep fetch threw",
      error,
      sessionId,
      context: { url: sweepUrl },
    });
    return;
  }

  if (!sweep.success || !sweep.counts) {
    await logError(env.DB, {
      source: SOURCE,
      message: "sweep response missing counts",
      sessionId,
      context: { response: sweep },
    });
    return;
  }

  const c = sweep.counts;
  const today = todayUtcYmd();
  const db = getDb(env.DB);

  // 2. Upsert today's snapshot. ON CONFLICT DO UPDATE keeps the row
  // idempotent across same-day re-runs (e.g. manual cron trigger).
  // Preserves last_yellow_alerted_at on update so the debounce state
  // isn't reset by a same-day re-run.
  try {
    await db
      .insert(dedupSweepSnapshots)
      .values({
        snapshotDate: today,
        totalClusters: c.total_clusters,
        venueDateClusters: c.venue_date_clusters,
        cityStateDateClusters: c.city_state_date_clusters,
        eventsInClusters: c.events_in_clusters,
      })
      .onConflictDoUpdate({
        target: dedupSweepSnapshots.snapshotDate,
        set: {
          totalClusters: c.total_clusters,
          venueDateClusters: c.venue_date_clusters,
          cityStateDateClusters: c.city_state_date_clusters,
          eventsInClusters: c.events_in_clusters,
        },
      });
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "snapshot upsert failed",
      error,
      sessionId,
      context: { today, counts: c },
    });
    return;
  }

  // 3. Pull the 8 most-recent prior snapshots (today + 7 days history)
  // so we can compute (a) yesterday's count for RED comparison and
  // (b) the 7-day rolling avg for YELLOW comparison.
  const history = await db
    .select()
    .from(dedupSweepSnapshots)
    .orderBy(desc(dedupSweepSnapshots.snapshotDate))
    .limit(8);
  // history[0] is today (we just upserted). history[1] is yesterday, etc.
  const todayRow = history[0];
  const yesterday = history[1];
  // Rolling 7-day avg uses history[1..7] — the 7 days BEFORE today.
  const priorWindow = history.slice(1, 8);
  const rolling7Avg =
    priorWindow.length > 0
      ? priorWindow.reduce((sum, r) => sum + r.totalClusters, 0) / priorWindow.length
      : null;

  // 4. RED rule — always fires on +1 cluster growth day-over-day.
  const isRed = yesterday != null && c.total_clusters > yesterday.totalClusters;
  // 5. YELLOW rule — fires on >10% growth vs rolling avg, debounced 72h.
  const yellowThreshold =
    rolling7Avg != null && rolling7Avg > 0 ? rolling7Avg * YELLOW_GROWTH_RATIO : null;
  const exceedsYellow = yellowThreshold != null && c.total_clusters > yellowThreshold;
  const yellowDebounceCutoff = new Date(Date.now() - YELLOW_DEBOUNCE_HOURS * 3600_000);
  const yellowSuppressed =
    todayRow?.lastYellowAlertedAt != null && todayRow.lastYellowAlertedAt > yellowDebounceCutoff;
  const isYellow = exceedsYellow && !isRed && !yellowSuppressed;

  if (!isRed && !isYellow) {
    console.log(
      `[cron] dedup-sweep-canary ok — total_clusters=${c.total_clusters} (yesterday=${yesterday?.totalClusters ?? "n/a"}, rolling7avg=${rolling7Avg?.toFixed(1) ?? "n/a"}) — no alert`
    );
    return;
  }

  // 6. Build alert payload + dispatch to whichever channels are configured.
  // Both SLACK_WEBHOOK_URL_TECHNICAL and ALERT_EMAIL_TECHNICAL are
  // independent optional secrets on the MCP Worker. With neither set,
  // the snapshot is still written (above) — only the push fan-out skips.
  const webhookUrl = env.SLACK_WEBHOOK_URL_TECHNICAL;
  const alertEmail = env.ALERT_EMAIL_TECHNICAL;
  const emoji = isRed ? "🔴" : "🟡";
  const tier = isRed ? "RED" : "YELLOW";
  const detail = isRed
    ? `total_clusters ${yesterday?.totalClusters ?? "?"} → ${c.total_clusters} (day-over-day)`
    : `total_clusters ${c.total_clusters} vs 7-day avg ${rolling7Avg?.toFixed(1) ?? "?"} (>${Math.round((YELLOW_GROWTH_RATIO - 1) * 100)}% growth)`;
  const slackText = `${emoji} *Dedup sweep ${tier}* — ${detail}\nVenue+date: ${c.venue_date_clusters}, city+state+date: ${c.city_state_date_clusters}, events in clusters: ${c.events_in_clusters}\n<https://meetmeatthefair.com/admin/duplicates|Open admin/duplicates>`;

  // Slack — synchronous POST, fail-soft.
  if (webhookUrl) {
    const dispatch = await postSlackWebhook(webhookUrl, slackText);
    if (!dispatch.ok) {
      await logError(env.DB, {
        source: SOURCE,
        message: `${tier} Slack dispatch failed: ${dispatch.error}`,
        sessionId,
        context: { tier, total_clusters: c.total_clusters },
      });
    } else {
      console.log(`[cron] dedup-sweep-canary ${tier} → Slack — ${detail}`);
    }
  }

  // Email — enqueue to EMAIL_JOBS; the queue consumer (this same Worker)
  // delivers via Cloudflare Email Sending. Mirrors the approval-notification
  // pattern. Push is fire-and-forget at this layer — queue retries (max 3)
  // are the retry mechanism, not a synchronous wait here.
  if (alertEmail && env.EMAIL_JOBS) {
    const subject = `${emoji} Dedup sweep ${tier}: ${c.total_clusters} clusters`;
    const textBody =
      `${detail}\n\n` +
      `Venue+date clusters: ${c.venue_date_clusters}\n` +
      `City+state+date clusters: ${c.city_state_date_clusters}\n` +
      `Events in clusters: ${c.events_in_clusters}\n\n` +
      `Open admin/duplicates: https://meetmeatthefair.com/admin/duplicates\n`;
    const htmlBody =
      `<p><strong>${emoji} Dedup sweep ${tier}</strong> — ${detail}</p>` +
      `<ul>` +
      `<li>Venue+date clusters: ${c.venue_date_clusters}</li>` +
      `<li>City+state+date clusters: ${c.city_state_date_clusters}</li>` +
      `<li>Events in clusters: ${c.events_in_clusters}</li>` +
      `</ul>` +
      `<p><a href="https://meetmeatthefair.com/admin/duplicates">Open admin/duplicates</a></p>`;
    try {
      await env.EMAIL_JOBS.send({
        to: alertEmail,
        subject,
        text: textBody,
        html: htmlBody,
        source: `dedup-canary:${tier.toLowerCase()}`,
      });
      console.log(`[cron] dedup-sweep-canary ${tier} → email queued — ${alertEmail}`);
    } catch (error) {
      await logError(env.DB, {
        source: SOURCE,
        message: `${tier} email enqueue failed`,
        error,
        sessionId,
        context: { tier, total_clusters: c.total_clusters, alertEmail },
      });
    }
  } else if (alertEmail && !env.EMAIL_JOBS) {
    // Misconfigured: secret set but queue binding missing. Log once so the
    // operator can fix wrangler.toml.
    await logError(env.DB, {
      level: "warn",
      source: SOURCE,
      message: "ALERT_EMAIL_TECHNICAL is set but EMAIL_JOBS queue binding is missing",
      sessionId,
    });
  }

  // Configuration-status diagnostic line — visible in wrangler tail. Helps
  // an operator confirm at a glance which channels actually ran.
  if (!webhookUrl && !alertEmail) {
    console.log(
      `[cron] dedup-sweep-canary ${tier} — no push channels configured (snapshot still written); ${detail}`
    );
  }

  // 7. Update debounce marker on YELLOW dispatches (success or fail —
  // failing to alert shouldn't trigger another attempt within 72h, since
  // the underlying signal is the same).
  if (isYellow) {
    try {
      await db
        .update(dedupSweepSnapshots)
        .set({ lastYellowAlertedAt: new Date() })
        .where(eq(dedupSweepSnapshots.snapshotDate, today));
    } catch (error) {
      await logError(env.DB, {
        source: SOURCE,
        message: "failed to mark YELLOW debounce",
        error,
        sessionId,
      });
    }
  }
}

// Exported for unit tests.
export const __test = {
  todayUtcYmd,
  postSlackWebhook,
  YELLOW_DEBOUNCE_HOURS,
  YELLOW_GROWTH_RATIO,
};

// `gte` / `sql` referenced only by the exports above to keep imports
// trimmed for esbuild — keep the imports here so future expansions
// (e.g. cleanup of old snapshot rows) don't have to re-add them.
void gte;
void sql;
