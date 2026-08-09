/**
 * OPE-348 (URGENT) — the watchdog that cannot die with the watched.
 *
 * 2026-08-05 → 2026-08-09: the Anthropic account's quota was exhausted and every
 * scheduled agent session failed at startup for ~four days. Newsletter issue #3
 * was never composed (the first missed Friday), no watches ran, no sweeps, no
 * queue-runner cycles — and nobody was told. The reason nobody was told is the
 * whole point of this file: every dead-man check we had ALSO ran on that
 * account. The watchdog died with the watched.
 *
 * So this runs on a Cloudflare cron and sends through the Cloudflare email
 * queue. It has zero Anthropic dependency by construction. It follows the same
 * reasoning as cpi-scan-watchdog.ts ("a probe watching the scan would be
 * evaluated BY the scan, so it could only ever report green") applied one level
 * up: to the agent layer itself.
 *
 * ── Choosing a signal that actually goes stale ──────────────────────────────
 * The obvious move is to watch an existing table. That would have failed.
 * During the outage `admin_actions` still received 3, 1, 2, 2 rows per day —
 * and every survivor was `ga4.liveness_alert` or `event.lifecycle_change`, both
 * written by Cloudflare crons that were completely unaffected. A watchdog keyed
 * on "did anything write to admin_actions?" would have reported healthy for the
 * entire outage.
 *
 * Hence `agent_heartbeats` with kind='agent': a row an agent SESSION writes, so
 * it goes stale exactly when sessions stop running. The watchdog's own stamps
 * use kind='watchdog' and are excluded from the freshness query, or it would
 * keep the table looking alive by observing it.
 */

import { desc, eq } from "drizzle-orm";
import { agentHeartbeats, newsletterIssues } from "./schema.js";
import { getDb } from "./db.js";
import { logError } from "./logger.js";
import type { Env } from "./index.js";

const SOURCE = "mcp:schedule:agent-silence-watchdog";

/** Reserved code for the watchdog's own run-stamp (OPE-246 evidence). */
export const WATCHDOG_CODE = "watchdog:agent-silence";

/**
 * How stale is too stale. 26h, not 24h: the daily agent run has some jitter, and
 * a threshold equal to the cadence alarms on ordinary lateness. Two hours of
 * slack costs at most two hours of detection delay against a four-day outage.
 */
export const SILENCE_THRESHOLD_MS = 26 * 60 * 60 * 1000;

/** Friday. `getUTCDay()` is 0=Sunday. */
const FRIDAY = 5;

/**
 * Newsletter compose lands early Friday UTC — the two real broadcasts were
 * created 00:42Z and 00:18Z and sent by 02:07Z. A Friday 06:00Z check is
 * therefore safely after compose, not racing it.
 *
 * 30h back from a 06:00Z Friday run reaches Thursday 00:00Z, so a compose that
 * runs any time Thursday or early Friday still counts.
 */
export const NEWSLETTER_LOOKBACK_MS = 30 * 60 * 60 * 1000;

export interface SilenceVerdict {
  silent: boolean;
  /** Newest agent heartbeat, or null when the table has never been written. */
  newestSeenAt: Date | null;
  staleHours: number | null;
  agentCode: string | null;
}

/**
 * Pure decision, so the threshold behaviour is testable without a clock or a DB.
 *
 * A table with NO agent rows at all reports silent=false, deliberately. Before
 * any agent has adopted the heartbeat call there is nothing to be stale, and
 * alarming daily until adoption would train the operator to ignore this exact
 * alert — the one alert that must never be ignored.
 */
export function decideSilence(
  newest: { agentCode: string; lastSeenAt: Date } | null,
  now: Date,
  thresholdMs: number = SILENCE_THRESHOLD_MS
): SilenceVerdict {
  if (!newest) {
    return { silent: false, newestSeenAt: null, staleHours: null, agentCode: null };
  }
  const ageMs = now.getTime() - newest.lastSeenAt.getTime();
  return {
    silent: ageMs > thresholdMs,
    newestSeenAt: newest.lastSeenAt,
    staleHours: Math.floor(ageMs / (60 * 60 * 1000)),
    agentCode: newest.agentCode,
  };
}

/** Should the newsletter tripwire run and, if so, did compose happen? */
export function decideNewsletterMissing(
  now: Date,
  latestIssueCreatedAt: Date | null,
  lookbackMs: number = NEWSLETTER_LOOKBACK_MS
): boolean {
  if (now.getUTCDay() !== FRIDAY) return false;
  if (!latestIssueCreatedAt) return true;
  return now.getTime() - latestIssueCreatedAt.getTime() > lookbackMs;
}

/**
 * Daily liveness check. Never throws — a watchdog that can crash is one that
 * stops watching, and this one has no watcher of its own.
 */
export async function runAgentSilenceWatchdog(env: Env): Promise<void> {
  const db = getDb(env.DB);
  const now = new Date();

  let newest: { agentCode: string; lastSeenAt: Date } | null = null;
  try {
    const [row] = await db
      .select({ agentCode: agentHeartbeats.agentCode, lastSeenAt: agentHeartbeats.lastSeenAt })
      .from(agentHeartbeats)
      // kind='agent' ONLY. Including the watchdog's own stamps would make the
      // table look alive every time this function runs — the failure mode this
      // whole file exists to avoid.
      .where(eq(agentHeartbeats.kind, "agent"))
      .orderBy(desc(agentHeartbeats.lastSeenAt))
      .limit(1);
    if (row?.lastSeenAt) newest = { agentCode: row.agentCode, lastSeenAt: row.lastSeenAt };
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "[agent-silence] heartbeat read failed",
      error,
    });
    return;
  }

  const verdict = decideSilence(newest, now);

  // Newsletter tripwire — a separate question from agent liveness, because the
  // compose can fail on its own while everything else runs.
  let newsletterMissing = false;
  try {
    const [issue] = await db
      .select({ createdAt: newsletterIssues.createdAt })
      .from(newsletterIssues)
      .orderBy(desc(newsletterIssues.createdAt))
      .limit(1);
    newsletterMissing = decideNewsletterMissing(now, issue?.createdAt ?? null);
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "[agent-silence] newsletter check failed",
      error,
    });
  }

  if (verdict.silent || newsletterMissing) {
    const lines: string[] = [];
    if (verdict.silent) {
      lines.push(
        `Agent layer SILENT — no agent heartbeat for ${verdict.staleHours}h ` +
          `(newest: ${verdict.agentCode} at ${verdict.newestSeenAt?.toISOString()}).`,
        "Likely Anthropic quota exhaustion or a trigger outage. Scheduled sessions are probably not running at all."
      );
    }
    if (newsletterMissing) {
      lines.push(
        "Newsletter: no issue composed in the last 30h on a Friday — this week's send is at risk."
      );
    }
    const subject = verdict.silent
      ? `🚨 Agent layer silent for ${verdict.staleHours}h`
      : "🚨 Newsletter not composed this week";

    const to = env.ALERT_EMAIL_TECHNICAL;
    if (to && env.EMAIL_JOBS) {
      try {
        await env.EMAIL_JOBS.send({
          to,
          subject,
          text: `${lines.join("\n\n")}\n\nSent by the Cloudflare watchdog, which has no Anthropic dependency.\n`,
          html: `<p><strong>${subject}</strong></p>${lines.map((l) => `<p>${l}</p>`).join("")}<p style="color:#666;font-size:12px">Sent by the Cloudflare watchdog, which has no Anthropic dependency.</p>`,
          source: "agent-silence-watchdog",
        });
        console.log(`[cron] agent-silence ALERT sent — ${subject}`);
      } catch (error) {
        await logError(env.DB, {
          source: SOURCE,
          message: "[agent-silence] alert enqueue failed",
          error,
        });
      }
    } else {
      await logError(env.DB, {
        level: "warn",
        source: SOURCE,
        message: `[agent-silence] would alert (${subject}) but ALERT_EMAIL_TECHNICAL/EMAIL_JOBS not configured`,
      });
    }
  } else {
    console.log(
      `[cron] agent-silence ok — newest=${verdict.newestSeenAt?.toISOString() ?? "none"}`
    );
  }

  // Stamp our own run LAST, so a crash above never looks like a healthy run.
  // This row is the OPE-246 evidence that the watchdog itself is executing —
  // without it, a silently-dead watchdog is indistinguishable from a quiet one.
  try {
    await db
      .insert(agentHeartbeats)
      .values({
        id: crypto.randomUUID(),
        agentCode: WATCHDOG_CODE,
        kind: "watchdog",
        lastSeenAt: now,
        note: verdict.silent ? "alerted" : "ok",
      })
      .onConflictDoUpdate({
        target: agentHeartbeats.agentCode,
        set: { lastSeenAt: now, kind: "watchdog", note: verdict.silent ? "alerted" : "ok" },
      });
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "[agent-silence] run-stamp write failed",
      error,
    });
  }
}
