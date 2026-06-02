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
 * Routes to SLACK_WEBHOOK_URL_TECHNICAL — same channel as the technical
 * KPI alerts (src/lib/kpi-alerts.ts). The webhook is a secret bound on
 * the MCP Worker; if not set, the dispatch returns ok with channel:"none"
 * and never throws (so CI/local without secrets still passes).
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

  // 6. Dispatch Slack alert. SLACK_WEBHOOK_URL_TECHNICAL is a secret on
  // the MCP Worker; if not set, the post no-ops and we log it as a
  // configuration note (not an error).
  const webhookUrl = env.SLACK_WEBHOOK_URL_TECHNICAL;
  const emoji = isRed ? "🔴" : "🟡";
  const tier = isRed ? "RED" : "YELLOW";
  const detail = isRed
    ? `total_clusters ${yesterday?.totalClusters ?? "?"} → ${c.total_clusters} (day-over-day)`
    : `total_clusters ${c.total_clusters} vs 7-day avg ${rolling7Avg?.toFixed(1) ?? "?"} (>${Math.round((YELLOW_GROWTH_RATIO - 1) * 100)}% growth)`;
  const text = `${emoji} *Dedup sweep ${tier}* — ${detail}\nVenue+date: ${c.venue_date_clusters}, city+state+date: ${c.city_state_date_clusters}, events in clusters: ${c.events_in_clusters}\n<https://meetmeatthefair.com/admin/duplicates|Open admin/duplicates>`;
  const dispatch = await postSlackWebhook(webhookUrl, text);

  if (!dispatch.ok) {
    await logError(env.DB, {
      source: SOURCE,
      message: `${tier} dispatch failed: ${dispatch.error}`,
      sessionId,
      context: { tier, total_clusters: c.total_clusters, webhookConfigured: Boolean(webhookUrl) },
    });
  } else {
    console.log(`[cron] dedup-sweep-canary ${tier} dispatched — ${detail}`);
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
