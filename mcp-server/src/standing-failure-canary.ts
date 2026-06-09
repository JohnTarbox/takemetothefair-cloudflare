/**
 * A5 (2026-06-08) — standing-failure detector.
 *
 * The companion to the page-error canary ([[page-error-canary.ts]]). That
 * canary watches for error_logs RATE bursts in a 10-min window — good for
 * catching deploy regressions and live outages. It missed REL3's signal
 * because REL3 produced ONE error per day for 22 days, never crossing any
 * per-window rate threshold.
 *
 * This detector watches for the orthogonal signal: error PERSISTENCE
 * across days. For each distinct error_logs.source in a 7-day window,
 * count distinct calendar days that had at least one error. If a source
 * appears on ≥3 distinct days AND today is one of them, fire a STANDING-
 * tier alert.
 *
 * Threshold rationale:
 *   - 3 days catches the "fires every day" pattern (REL3's exact shape)
 *     within 3 days — fast enough to be useful, slow enough to ignore
 *     a 1-day blip + retry the next day.
 *   - "Today must be one of them" filters out resolved issues that are
 *     now historical (otherwise we'd re-alert on stale data for 7 days
 *     after a fix lands).
 *
 * Debounce: 7-day per-source. Once alerted, don't re-alert until either
 * the operator fixes it (rows stop appearing in window) or 7 days pass.
 *
 * Cron attachment: daily `0 6 * * *` (same fire as REL3). Slow-moving
 * signal — 24h latency is fine; reading 7 days of error_logs once per
 * 10 min would be wasteful.
 *
 * Dispatch channels: same fan-out as page-error canary —
 * `SLACK_WEBHOOK_URL_TECHNICAL` + `ALERT_EMAIL_TECHNICAL`. Both optional;
 * with neither set, the canary still runs (computes detection, updates
 * debounce row) but never pushes — purely log-only via the persisted state.
 */
import { and, eq, gte, sql, isNotNull } from "drizzle-orm";
import { errorLogs, standingFailureState } from "@takemetothefair/db-schema";
import type { Env } from "./index.js";
import { getDb } from "./db.js";
import { logError } from "./logger.js";

const SLACK_BUDGET_MS = 5_000;
const SOURCE = "mcp:schedule:standing-failure-canary";

/** Look-back window in days for the persistence query. */
const WINDOW_DAYS = 7;

/** Minimum distinct calendar days a source must appear on within the
 *  window to qualify for a STANDING alert. */
const MIN_DAY_COUNT = 3;

/** Per-source debounce window. Aligned with the look-back window so the
 *  signal "resets" naturally if the operator fixes the issue. */
const DEBOUNCE_DAYS = 7;

/** Cap on sources we evaluate per fire — defense-in-depth against a
 *  pathological case where dozens of sources are all standing-failing.
 *  Operator triage capacity is the bottleneck; if we ever hit this cap,
 *  the canary will surface a meta-error so we know to investigate. */
const MAX_SOURCES_PER_FIRE = 20;

export interface DailyCount {
  /** Date string in YYYY-MM-DD format, UTC. */
  day: string;
  count: number;
}

/** Pure decision function — exported for unit tests. Decides whether a
 *  source should fire a STANDING alert.
 *
 *  Returns `null` for no-alert; otherwise returns the day count that
 *  drove the decision so the dispatch message can quote it.
 *
 *  Inputs:
 *   - `dailyCounts`: ordered descending by day (most recent first).
 *     Each entry is one calendar day in UTC that had ≥1 error.
 *   - `lastAlertedAt`: previous dispatch timestamp for this source,
 *     or null if never alerted.
 *   - `today`: UTC date string (YYYY-MM-DD) at the time of evaluation.
 *   - `now`: current time, for debounce math.
 */
export function decideStandingFailure(
  dailyCounts: DailyCount[],
  lastAlertedAt: Date | null,
  today: string,
  now: Date
): { dayCount: number; totalCount: number } | null {
  // Must have appeared today (filters out stale historical recurrences).
  const hasToday = dailyCounts.some((d) => d.day === today);
  if (!hasToday) return null;

  // Must span ≥ MIN_DAY_COUNT distinct days within window.
  if (dailyCounts.length < MIN_DAY_COUNT) return null;

  // Debounce check.
  if (lastAlertedAt) {
    const debounceCutoff = new Date(now.getTime() - DEBOUNCE_DAYS * 86400_000);
    if (lastAlertedAt >= debounceCutoff) return null;
  }

  const totalCount = dailyCounts.reduce((acc, d) => acc + d.count, 0);
  return { dayCount: dailyCounts.length, totalCount };
}

/** POST a Slack message via the incoming-webhook URL. Mirrors the shape
 *  in page-error-canary.ts (kept private here rather than extracting a
 *  shared helper — two canaries' worth of reuse is the cutoff before
 *  extracting per the page-error-canary comment). */
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

/** Format a Date as `YYYY-MM-DD` in UTC. Stable across timezones — the
 *  daily-grouping in the SQL query uses UTC too. */
function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Main entry point. Exported for both index.ts and unit tests.
 *
 * Idempotent: re-running within a single day will re-evaluate against
 * the same error_logs rows. The 7-day per-source debounce prevents
 * re-dispatching for sources we've already alerted on.
 */
export async function runScheduledStandingFailureCanary(env: Env): Promise<void> {
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 86400_000);
  const today = utcDayKey(now);
  const db = getDb(env.DB);

  // Aggregate by (source, day) over the window. SQLite's strftime is
  // available via the integer-mode timestamp column (drizzle converts on
  // read, so the SELECT gives seconds back to us). We use unixepoch()
  // semantics: `(timestamp / 86400) * 86400` truncated to day boundary,
  // then format as YYYY-MM-DD.
  let rows: Array<{ source: string | null; day: string; count: number }>;
  try {
    rows = await db
      .select({
        source: errorLogs.source,
        day: sql<string>`strftime('%Y-%m-%d', ${errorLogs.timestamp}, 'unixepoch')`,
        count: sql<number>`count(*)`,
      })
      .from(errorLogs)
      .where(
        and(
          gte(errorLogs.timestamp, windowStart),
          eq(errorLogs.level, "error"),
          isNotNull(errorLogs.source)
        )
      )
      .groupBy(errorLogs.source, sql`strftime('%Y-%m-%d', ${errorLogs.timestamp}, 'unixepoch')`);
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "error_logs aggregate query failed",
      error,
      sessionId,
    });
    return;
  }

  // Group rows into per-source daily-counts maps.
  const bySource = new Map<string, DailyCount[]>();
  for (const row of rows) {
    if (!row.source) continue;
    const list = bySource.get(row.source) ?? [];
    list.push({ day: row.day, count: row.count });
    bySource.set(row.source, list);
  }

  // Filter to candidates (sources with ≥ MIN_DAY_COUNT distinct days)
  // before reading any debounce state — most sources won't qualify.
  const candidates: string[] = [];
  for (const [source, days] of bySource.entries()) {
    if (days.length >= MIN_DAY_COUNT) candidates.push(source);
  }
  if (candidates.length === 0) {
    console.log(`[cron] standing-failure-canary ok — no source qualifies (window=${WINDOW_DAYS}d)`);
    return;
  }
  if (candidates.length > MAX_SOURCES_PER_FIRE) {
    await logError(env.DB, {
      level: "warn",
      source: SOURCE,
      message: `${candidates.length} sources qualify — exceeds MAX_SOURCES_PER_FIRE (${MAX_SOURCES_PER_FIRE}); truncating`,
      sessionId,
      context: { candidateCount: candidates.length, max: MAX_SOURCES_PER_FIRE },
    });
    candidates.length = MAX_SOURCES_PER_FIRE;
  }

  // Load debounce state for candidate sources only.
  const debounceBySource = new Map<string, Date>();
  try {
    const stateRows = await db.select().from(standingFailureState);
    for (const row of stateRows) {
      debounceBySource.set(row.source, row.lastAlertedAt);
    }
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "standing_failure_state read failed",
      error,
      sessionId,
    });
    return;
  }

  const webhookUrl = env.SLACK_WEBHOOK_URL_TECHNICAL;
  const alertEmail = env.ALERT_EMAIL_TECHNICAL;
  let firedCount = 0;
  let skippedDebouncedCount = 0;
  let skippedNoTodayCount = 0;

  for (const source of candidates) {
    const dailyCounts = bySource.get(source) ?? [];
    const lastAlerted = debounceBySource.get(source) ?? null;
    const decision = decideStandingFailure(dailyCounts, lastAlerted, today, now);
    if (!decision) {
      // Distinguish debounce-skip from no-today-skip so the cron log is
      // useful; both are non-error outcomes.
      const hasToday = dailyCounts.some((d) => d.day === today);
      if (!hasToday) skippedNoTodayCount++;
      else skippedDebouncedCount++;
      continue;
    }
    firedCount++;

    const slackText =
      `🟠 *Standing-failure canary* — \`${source}\` recurring across ` +
      `${decision.dayCount} of last ${WINDOW_DAYS} days ` +
      `(${decision.totalCount} errors total)` +
      `\n<https://meetmeatthefair.com/admin/error-logs?source=${encodeURIComponent(source)}|Open admin/error-logs>`;

    if (webhookUrl) {
      const dispatch = await postSlackWebhook(webhookUrl, slackText);
      if (!dispatch.ok) {
        await logError(env.DB, {
          source: SOURCE,
          message: `Slack dispatch failed for ${source}: ${dispatch.error}`,
          sessionId,
          context: { source, dayCount: decision.dayCount, totalCount: decision.totalCount },
        });
      } else {
        console.log(
          `[cron] standing-failure-canary fired — src=${source} days=${decision.dayCount} total=${decision.totalCount}`
        );
      }
    }

    if (alertEmail && env.EMAIL_JOBS) {
      const subject = `🟠 Standing-failure canary: ${source} (${decision.dayCount}/${WINDOW_DAYS}d)`;
      const textBody =
        `\`${source}\` has produced errors on ${decision.dayCount} of the last ${WINDOW_DAYS} days ` +
        `(${decision.totalCount} total).\n\n` +
        `Open admin/error-logs filtered: https://meetmeatthefair.com/admin/error-logs?source=${encodeURIComponent(source)}\n`;
      const htmlBody =
        `<p><strong>🟠 Standing-failure canary</strong> — <code>${source}</code> recurring across <strong>${decision.dayCount}</strong> of last ${WINDOW_DAYS} days (${decision.totalCount} errors total)</p>` +
        `<p><a href="https://meetmeatthefair.com/admin/error-logs?source=${encodeURIComponent(source)}">Open admin/error-logs filtered by source</a></p>`;
      try {
        await env.EMAIL_JOBS.send({
          to: alertEmail,
          subject,
          text: textBody,
          html: htmlBody,
          source: "standing-failure-canary",
        });
      } catch (error) {
        await logError(env.DB, {
          source: SOURCE,
          message: `email enqueue failed for ${source}`,
          error,
          sessionId,
          context: {
            source,
            dayCount: decision.dayCount,
            totalCount: decision.totalCount,
            alertEmail,
          },
        });
      }
    } else if (alertEmail && !env.EMAIL_JOBS && firedCount === 1) {
      await logError(env.DB, {
        level: "warn",
        source: SOURCE,
        message: "ALERT_EMAIL_TECHNICAL is set but EMAIL_JOBS queue binding is missing",
        sessionId,
      });
    }

    // Upsert debounce row regardless of dispatch outcome — if dispatch
    // failed, retrying every fire isn't useful (Slack down is rate-of-
    // signal, not persistence-of-signal), and the 7-day debounce is the
    // mute window we want either way.
    try {
      await db
        .insert(standingFailureState)
        .values({
          source,
          lastAlertedAt: now,
          lastDayCount: decision.dayCount,
          lastTotalCount: decision.totalCount,
        })
        .onConflictDoUpdate({
          target: standingFailureState.source,
          set: {
            lastAlertedAt: now,
            lastDayCount: decision.dayCount,
            lastTotalCount: decision.totalCount,
          },
        });
    } catch (error) {
      await logError(env.DB, {
        source: SOURCE,
        message: `debounce row upsert failed for ${source}`,
        error,
        sessionId,
        context: { source, dayCount: decision.dayCount, totalCount: decision.totalCount },
      });
    }
  }

  console.log(
    `[cron] standing-failure-canary fired=${firedCount} debounced=${skippedDebouncedCount} ` +
      `no-today=${skippedNoTodayCount} (window=${WINDOW_DAYS}d, candidates=${candidates.length})`
  );
}

// Exported for unit tests.
export const __test = {
  decideStandingFailure,
  postSlackWebhook,
  utcDayKey,
  WINDOW_DAYS,
  MIN_DAY_COUNT,
  DEBOUNCE_DAYS,
  MAX_SOURCES_PER_FIRE,
};
