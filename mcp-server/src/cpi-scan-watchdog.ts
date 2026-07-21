/**
 * OPE-259 — dead-man's switch for the 06:00 CPI scan.
 *
 * ## Why this exists
 *
 * On 2026-07-19 the 06:00 scan skipped the day entirely and **nothing
 * noticed**: no stale-red digest, no `health_issues.last_detected_at` updates,
 * no goodwill-red email — while the separate 06:01 vendor-roster email DID
 * send, so it was not a platform-wide cron outage. One skipped day,
 * self-recovered, zero alarms.
 *
 * That matters more than a normal missed job, because the scan is the
 * EVALUATOR for every heartbeat probe, queue-freeze and integration-silence
 * red. When it dies, the entire sensing layer goes dark — and every alarm that
 * would have told us is downstream of the thing that died.
 *
 * ## Why it is not a heartbeat probe
 *
 * The obvious move is a `cpi-scan` probe on `max(queue_drain_snapshots.created_at)`.
 * That would be **circular**: heartbeat probes are evaluated *by the scan*
 * (`assessAllHeartbeat` runs inside stale-red-scan), so a probe watching the
 * scan only ever runs when the scan is alive, and reports green precisely when
 * it has nothing to say. A monitor downstream of the thing it monitors is not a
 * monitor.
 *
 * So this is a genuinely independent leg:
 *   - different trigger  — the 08:00 cron, not the 06:00 one
 *   - different worker   — MCP, whereas the scan is a main-app route
 *   - different evidence — reads D1 directly, not the scan's own output
 *   - different delivery — enqueues its own email
 *
 * It shares only D1 and the email queue with what it guards. If EITHER 06:00
 * cron delivery or the main-app route is broken, this still fires.
 */
import { logError } from "./logger.js";

/**
 * How stale the newest snapshot may get before we alarm.
 *
 * 30h, not 24h: the scan runs daily at 06:00, so a healthy gap is ~24h and a
 * 24h threshold would false-fire on ordinary jitter. 30h means "you missed a
 * day" and cannot be produced by a merely-late run. The watchdog itself runs at
 * 08:00, two hours after the scan, so a genuine miss surfaces the same morning
 * — well inside the 24h requirement.
 */
export const CPI_SCAN_STALE_HOURS = 30;

interface WatchdogEnv {
  DB: D1Database;
  EMAIL_JOBS?: { send: (msg: Record<string, unknown>) => Promise<unknown> };
  ALERT_EMAIL_TECHNICAL?: string;
}

export interface WatchdogResult {
  lastSnapshotAt: Date | null;
  ageHours: number | null;
  stale: boolean;
  alerted: boolean;
}

/**
 * Check that the CPI scan produced evidence recently; alert if not.
 *
 * Failsoft: logs and returns, never throws into the cron branch. A watchdog
 * that can crash its own scheduler is worse than none.
 */
export async function runScheduledCpiScanWatchdog(
  env: WatchdogEnv,
  now: Date = new Date()
): Promise<WatchdogResult> {
  const SOURCE = "mcp:schedule:cpi-scan-watchdog";
  const sessionId = crypto.randomUUID();
  const result: WatchdogResult = {
    lastSnapshotAt: null,
    ageHours: null,
    stale: false,
    alerted: false,
  };

  try {
    // Raw D1 rather than drizzle: this table is main-app-owned and absent from
    // the MCP schema. A one-column freshness read does not justify duplicating
    // the table definition here, which would be a drift risk of its own.
    const row = await env.DB.prepare(
      "SELECT MAX(created_at) AS last_at FROM queue_drain_snapshots"
    ).first<{ last_at: number | null }>();

    const lastAt = row?.last_at ?? null;
    result.lastSnapshotAt = lastAt != null ? new Date(Number(lastAt) * 1000) : null;
    result.ageHours =
      result.lastSnapshotAt != null
        ? (now.getTime() - result.lastSnapshotAt.getTime()) / 3_600_000
        : null;

    // A table that has NEVER been written is not treated as stale: the drain
    // snapshots shipped recently (OPE-247), so an empty table on a fresh
    // environment means "not started yet", not "the scan died". Alarming on it
    // would train the operator to ignore this alert before it ever matters.
    if (result.ageHours == null) {
      await logError(env.DB, {
        level: "warn",
        source: SOURCE,
        message: "no queue_drain_snapshots rows yet — watchdog idle, not alarming",
        sessionId,
      });
      return result;
    }

    result.stale = result.ageHours > CPI_SCAN_STALE_HOURS;
    if (!result.stale) {
      console.log(`[cron] cpi-scan-watchdog ok age=${result.ageHours.toFixed(1)}h`);
      return result;
    }

    const ageH = result.ageHours.toFixed(1);
    const lastIso = result.lastSnapshotAt?.toISOString() ?? "never";
    const subject = `🔴 CPI scan appears DEAD — no evidence for ${ageH}h`;
    const text =
      `The 06:00 CPI stale-red scan has not written a queue_drain_snapshots row in ${ageH}h ` +
      `(last: ${lastIso}; threshold ${CPI_SCAN_STALE_HOURS}h).\n\n` +
      `This matters more than one missed job: the scan EVALUATES every heartbeat probe, ` +
      `queue-freeze and integration-silence red. While it is down, those alarms cannot fire — ` +
      `the dashboard will look calm because nothing is being measured, not because nothing is wrong.\n\n` +
      `Check the MCP Worker's 06:00 cron and POST /api/internal/cpi/stale-red-scan.\n` +
      `Admin: https://meetmeatthefair.com/admin/analytics\n`;
    const html =
      `<p><strong>🔴 CPI scan appears DEAD</strong> — no <code>queue_drain_snapshots</code> row in <strong>${ageH}h</strong> (last: ${lastIso}, threshold ${CPI_SCAN_STALE_HOURS}h).</p>` +
      `<p>The scan <em>evaluates</em> every heartbeat probe, queue-freeze and integration-silence red. While it is down those alarms cannot fire — the dashboard looks calm because nothing is being measured, not because nothing is wrong.</p>` +
      `<p>Check the MCP Worker 06:00 cron and <code>POST /api/internal/cpi/stale-red-scan</code>.<br>` +
      `<a href="https://meetmeatthefair.com/admin/analytics">Open admin analytics</a></p>`;

    if (env.ALERT_EMAIL_TECHNICAL && env.EMAIL_JOBS) {
      await env.EMAIL_JOBS.send({
        to: env.ALERT_EMAIL_TECHNICAL,
        subject,
        text,
        html,
        source: "cpi-scan-watchdog",
      });
      result.alerted = true;
    } else {
      await logError(env.DB, {
        level: "warn",
        source: SOURCE,
        message: "CPI scan stale but ALERT_EMAIL_TECHNICAL/EMAIL_JOBS not configured",
        sessionId,
        context: { ageHours: result.ageHours },
      });
    }

    // Logged as well as emailed: the OPE-73 lesson is that an alert delivered
    // to exactly one channel is an alert that can be missed entirely.
    await logError(env.DB, {
      level: "error",
      source: SOURCE,
      message: `CPI scan stale: no snapshot in ${ageH}h`,
      sessionId,
      context: { ageHours: result.ageHours, lastSnapshotAt: lastIso, alerted: result.alerted },
    });
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "cpi scan watchdog threw",
      error,
      sessionId,
    });
  }

  return result;
}
