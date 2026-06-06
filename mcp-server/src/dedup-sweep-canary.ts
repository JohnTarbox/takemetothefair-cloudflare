/**
 * A3 / K2 part 7 (analyst 2026-06-01 EVE) — daily Slack canary for the
 * dedup sweep cluster count.
 *
 * Polls GET https://meetmeatthefair.com/api/admin/duplicates/sweep
 * (events) or /api/admin/duplicates/sweep-entities (venues + promoters),
 * INSERTs today's snapshot into dedup_sweep_snapshots keyed by
 * (snapshot_date, surface), computes deltas vs yesterday + 7-day
 * rolling avg, and dispatches a Slack alert when the cluster count
 * moves materially. Wired into the daily cron branch in
 * mcp-server/src/index.ts.
 *
 * B — DQ1 (2026-06-06) extends the original events-only canary to
 * venues + promoters via a `surface` parameter. Same alert shape per
 * surface; the surface name appears in the Slack/email subject so the
 * on-call sees which kind of dup grew.
 *
 * Alert tiers (same per surface):
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
import { eq, and, gte, sql, desc } from "drizzle-orm";
import { dedupSweepSnapshots } from "@takemetothefair/db-schema";
import type { Env } from "./index.js";
import { getDb } from "./db.js";
import { logError } from "./logger.js";

/** Surface this canary monitors. Events is the original tenant; venues +
 *  promoters joined in B/DQ1 (2026-06-06). */
export type DedupSurface = "events" | "venues" | "promoters";

const SLACK_BUDGET_MS = 5_000;
/** Hours of suppression after a YELLOW dispatch before the next YELLOW is allowed. */
const YELLOW_DEBOUNCE_HOURS = 72;
/** Growth ratio that triggers YELLOW (10%). RED bypasses entirely. */
const YELLOW_GROWTH_RATIO = 1.1;

/** Sweep response — events shape, from
 *  src/app/api/admin/duplicates/sweep/route.ts. */
interface EventsSweepResponse {
  success: boolean;
  counts?: {
    venue_date_clusters: number;
    city_state_date_clusters: number;
    total_clusters: number;
    events_in_clusters: number;
  };
  error?: string;
}

/** Sweep response — venue + promoter shape, from
 *  src/app/api/admin/duplicates/sweep-entities/route.ts. */
interface EntitiesSweepResponse {
  success: boolean;
  counts?: {
    venue_clusters: number;
    promoter_clusters: number;
    total_clusters: number;
    venues_in_clusters: number;
    promoters_in_clusters: number;
  };
  error?: string;
}

/** Per-surface snapshot row to write. eventsInClusters is the generic
 *  "items in clusters" count for the surface; the events-specific
 *  sub-breakdowns (venueDateClusters, cityStateDateClusters) carry 0
 *  for non-events surfaces. */
interface SurfaceSnapshot {
  totalClusters: number;
  venueDateClusters: number;
  cityStateDateClusters: number;
  /** "Items in clusters" for the active surface (events / venues / promoters). */
  eventsInClusters: number;
  /** Optional pretty breakdown for the Slack/email body. */
  bodyLines: string[];
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

/** Per-surface sweep config: how to fetch + how to read counts off the
 *  response. Keeps `runScheduledDedupSweepCanary` itself surface-neutral. */
function sweepConfigFor(surface: DedupSurface): {
  pathWithQuery: string;
  adminPath: string;
  parseCounts: (raw: unknown) => SurfaceSnapshot | null;
} {
  if (surface === "events") {
    return {
      pathWithQuery: "/api/admin/duplicates/sweep?limit=500",
      adminPath: "/admin/duplicates",
      parseCounts: (raw) => {
        const r = raw as EventsSweepResponse;
        if (!r.success || !r.counts) return null;
        const c = r.counts;
        return {
          totalClusters: c.total_clusters,
          venueDateClusters: c.venue_date_clusters,
          cityStateDateClusters: c.city_state_date_clusters,
          eventsInClusters: c.events_in_clusters,
          bodyLines: [
            `Venue+date clusters: ${c.venue_date_clusters}`,
            `City+state+date clusters: ${c.city_state_date_clusters}`,
            `Events in clusters: ${c.events_in_clusters}`,
          ],
        };
      },
    };
  }
  // venues + promoters share the entity-sweep endpoint and shape.
  return {
    pathWithQuery: "/api/admin/duplicates/sweep-entities?limit=500",
    adminPath: "/admin/duplicates",
    parseCounts: (raw) => {
      const r = raw as EntitiesSweepResponse;
      if (!r.success || !r.counts) return null;
      const c = r.counts;
      if (surface === "venues") {
        return {
          totalClusters: c.venue_clusters,
          venueDateClusters: 0,
          cityStateDateClusters: 0,
          eventsInClusters: c.venues_in_clusters,
          bodyLines: [
            `Venue clusters: ${c.venue_clusters}`,
            `Venues in clusters: ${c.venues_in_clusters}`,
          ],
        };
      }
      // promoters
      return {
        totalClusters: c.promoter_clusters,
        venueDateClusters: 0,
        cityStateDateClusters: 0,
        eventsInClusters: c.promoters_in_clusters,
        bodyLines: [
          `Promoter clusters: ${c.promoter_clusters}`,
          `Promoters in clusters: ${c.promoters_in_clusters}`,
        ],
      };
    },
  };
}

/** Title-case for the alert subject ("Events" / "Venues" / "Promoters"). */
function surfaceTitle(surface: DedupSurface): string {
  return surface.charAt(0).toUpperCase() + surface.slice(1);
}

/**
 * Exported for unit tests + index.ts. Idempotent within a day per
 * surface — (snapshot_date, surface) is UNIQUE so re-running same-day
 * UPDATEs in place rather than failing.
 *
 * Default `surface` is "events" for backwards-compat with the original
 * single-surface call site; the daily cron explicitly passes all three
 * surfaces (see mcp-server/src/index.ts daily branch).
 */
export async function runScheduledDedupSweepCanary(
  env: Env,
  surface: DedupSurface = "events"
): Promise<void> {
  const SOURCE = `mcp:schedule:dedup-sweep-canary:${surface}`;
  const sessionId = crypto.randomUUID();
  const cfg = sweepConfigFor(surface);

  // 1. Fetch the live sweep response for this surface.
  const sweepUrl = `${env.MAIN_APP_URL ?? "https://meetmeatthefair.com"}${cfg.pathWithQuery}`;
  let snapshot: SurfaceSnapshot;
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
        context: { url: sweepUrl, status: response.status, bodyExcerpt: body, surface },
      });
      return;
    }
    const raw = await response.json();
    const parsed = cfg.parseCounts(raw);
    if (!parsed) {
      await logError(env.DB, {
        source: SOURCE,
        message: "sweep response missing counts",
        sessionId,
        context: { response: raw, surface },
      });
      return;
    }
    snapshot = parsed;
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "sweep fetch threw",
      error,
      sessionId,
      context: { url: sweepUrl, surface },
    });
    return;
  }

  const today = todayUtcYmd();
  const db = getDb(env.DB);

  // 2. Upsert today's snapshot. ON CONFLICT DO UPDATE on (snapshot_date,
  // surface) keeps the row idempotent across same-day re-runs (e.g.
  // manual cron trigger). Preserves last_yellow_alerted_at on update so
  // the debounce state isn't reset by a same-day re-run.
  try {
    await db
      .insert(dedupSweepSnapshots)
      .values({
        snapshotDate: today,
        surface,
        totalClusters: snapshot.totalClusters,
        venueDateClusters: snapshot.venueDateClusters,
        cityStateDateClusters: snapshot.cityStateDateClusters,
        eventsInClusters: snapshot.eventsInClusters,
      })
      .onConflictDoUpdate({
        target: [dedupSweepSnapshots.snapshotDate, dedupSweepSnapshots.surface],
        set: {
          totalClusters: snapshot.totalClusters,
          venueDateClusters: snapshot.venueDateClusters,
          cityStateDateClusters: snapshot.cityStateDateClusters,
          eventsInClusters: snapshot.eventsInClusters,
        },
      });
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "snapshot upsert failed",
      error,
      sessionId,
      context: { today, surface, snapshot },
    });
    return;
  }

  // 3. Pull the 8 most-recent prior snapshots FOR THIS SURFACE (today
  // + 7 days history) so we can compute (a) yesterday's count for RED
  // comparison and (b) the 7-day rolling avg for YELLOW comparison.
  // The surface filter is load-bearing — without it the events history
  // would contaminate the venues/promoters baseline.
  const history = await db
    .select()
    .from(dedupSweepSnapshots)
    .where(eq(dedupSweepSnapshots.surface, surface))
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
  const isRed = yesterday != null && snapshot.totalClusters > yesterday.totalClusters;
  // 5. YELLOW rule — fires on >10% growth vs rolling avg, debounced 72h.
  const yellowThreshold =
    rolling7Avg != null && rolling7Avg > 0 ? rolling7Avg * YELLOW_GROWTH_RATIO : null;
  const exceedsYellow = yellowThreshold != null && snapshot.totalClusters > yellowThreshold;
  const yellowDebounceCutoff = new Date(Date.now() - YELLOW_DEBOUNCE_HOURS * 3600_000);
  const yellowSuppressed =
    todayRow?.lastYellowAlertedAt != null && todayRow.lastYellowAlertedAt > yellowDebounceCutoff;
  const isYellow = exceedsYellow && !isRed && !yellowSuppressed;

  if (!isRed && !isYellow) {
    console.log(
      `[cron] dedup-sweep-canary[${surface}] ok — total_clusters=${snapshot.totalClusters} (yesterday=${yesterday?.totalClusters ?? "n/a"}, rolling7avg=${rolling7Avg?.toFixed(1) ?? "n/a"}) — no alert`
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
  const surfaceLabel = surfaceTitle(surface);
  const detail = isRed
    ? `total_clusters ${yesterday?.totalClusters ?? "?"} → ${snapshot.totalClusters} (day-over-day)`
    : `total_clusters ${snapshot.totalClusters} vs 7-day avg ${rolling7Avg?.toFixed(1) ?? "?"} (>${Math.round((YELLOW_GROWTH_RATIO - 1) * 100)}% growth)`;
  const bodyJoined = snapshot.bodyLines.join(", ");
  const slackText = `${emoji} *${surfaceLabel} dedup ${tier}* — ${detail}\n${bodyJoined}\n<https://meetmeatthefair.com${cfg.adminPath}|Open admin/duplicates>`;

  // Slack — synchronous POST, fail-soft.
  if (webhookUrl) {
    const dispatch = await postSlackWebhook(webhookUrl, slackText);
    if (!dispatch.ok) {
      await logError(env.DB, {
        source: SOURCE,
        message: `${tier} Slack dispatch failed: ${dispatch.error}`,
        sessionId,
        context: { tier, surface, total_clusters: snapshot.totalClusters },
      });
    } else {
      console.log(`[cron] dedup-sweep-canary[${surface}] ${tier} → Slack — ${detail}`);
    }
  }

  // Email — enqueue to EMAIL_JOBS; the queue consumer (this same Worker)
  // delivers via Cloudflare Email Sending. Mirrors the approval-notification
  // pattern. Push is fire-and-forget at this layer — queue retries (max 3)
  // are the retry mechanism, not a synchronous wait here.
  if (alertEmail && env.EMAIL_JOBS) {
    const subject = `${emoji} ${surfaceLabel} dedup ${tier}: ${snapshot.totalClusters} clusters`;
    const textBody =
      `${detail}\n\n` +
      snapshot.bodyLines.join("\n") +
      `\n\n` +
      `Open admin/duplicates: https://meetmeatthefair.com${cfg.adminPath}\n`;
    const htmlBody =
      `<p><strong>${emoji} ${surfaceLabel} dedup ${tier}</strong> — ${detail}</p>` +
      `<ul>${snapshot.bodyLines.map((l) => `<li>${l}</li>`).join("")}</ul>` +
      `<p><a href="https://meetmeatthefair.com${cfg.adminPath}">Open admin/duplicates</a></p>`;
    try {
      await env.EMAIL_JOBS.send({
        to: alertEmail,
        subject,
        text: textBody,
        html: htmlBody,
        source: `dedup-canary:${surface}:${tier.toLowerCase()}`,
      });
      console.log(`[cron] dedup-sweep-canary[${surface}] ${tier} → email queued — ${alertEmail}`);
    } catch (error) {
      await logError(env.DB, {
        source: SOURCE,
        message: `${tier} email enqueue failed`,
        error,
        sessionId,
        context: { tier, surface, total_clusters: snapshot.totalClusters, alertEmail },
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
      `[cron] dedup-sweep-canary[${surface}] ${tier} — no push channels configured (snapshot still written); ${detail}`
    );
  }

  // 7. Update debounce marker on YELLOW dispatches (success or fail —
  // failing to alert shouldn't trigger another attempt within 72h, since
  // the underlying signal is the same). Surface-scoped — venues YELLOW
  // doesn't suppress events YELLOW.
  if (isYellow) {
    try {
      await db
        .update(dedupSweepSnapshots)
        .set({ lastYellowAlertedAt: new Date() })
        .where(
          and(eq(dedupSweepSnapshots.snapshotDate, today), eq(dedupSweepSnapshots.surface, surface))
        );
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
