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
/**
 * Only the bindings this watchdog actually touches. Narrower than the Worker's
 * full `Env` on purpose: the drill is invoked from the MCP tool layer, whose
 * env is typed as a subset, and widening that to the whole Env — or casting —
 * would hide whether `DB` is really bound at the call site. A structural type
 * makes the caller prove it.
 */
export interface WatchdogEnv {
  DB: D1Database;
  EMAIL_JOBS?: Queue;
  ALERT_EMAIL_TECHNICAL?: string;
}

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
 * Drill controls (OPE-348 rework, 2026-08-11).
 *
 * An alarm that has only ever reported "ok" is not a proven alarm — it is an
 * untested one, and this ticket exists precisely because every previous
 * dead-man check reported healthy through a four-day blackout. So the positive
 * case has to be exercisable on demand.
 *
 * The deliberate choice here is to inject ONLY a clock and a threshold. The
 * read, the decision, the message, the enqueue and the delivery are the same
 * lines production runs — there is no drill-only branch in the alerting path,
 * so a passing drill is evidence about the real code rather than about a
 * parallel test harness. It also means the drill needs no write access to
 * `agent_heartbeats`: rehearsing the alarm never touches production data.
 */
export interface WatchdogRunOptions {
  /**
   * Injected clock. Production passes nothing and uses the real time; a drill
   * passes a future instant so the real freshness maths runs against the real
   * rows currently in the table.
   */
  now?: Date;
  /**
   * Threshold override. Used by drills to isolate one half of the check —
   * e.g. an enormous threshold suppresses the silence alarm so the newsletter
   * tripwire can be rehearsed on its own.
   */
  thresholdMs?: number;
  /**
   * Rehearsal. Two effects, both load-bearing for safety:
   *  - the subject gets a `[DRILL]` prefix, so a rehearsal can never be
   *    mistaken for a genuine outage in the operator's inbox;
   *  - the run-stamp is SKIPPED, so a drill never overwrites the watchdog's own
   *    liveness row — that row is the OPE-246 first-evidence trail, and a drill
   *    writing `note='alerted'` into it would corrupt exactly the evidence this
   *    ticket is trying to establish.
   */
  drill?: boolean;
  /** Compute and report the verdict without enqueuing anything. */
  dryRun?: boolean;
}

/** What a run decided and did — returned so a drill can be reported honestly. */
export interface WatchdogRunResult {
  silent: boolean;
  newsletterMissing: boolean;
  /** OPE-348 follow-up — composed but never delivered. */
  newsletterUnsent: boolean;
  /** True only when a message was actually handed to the queue. */
  alerted: boolean;
  subject: string | null;
  recipients: string | null;
  newestSeenAt: string | null;
  staleHours: number | null;
  agentCode: string | null;
  drill: boolean;
  dryRun: boolean;
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
 * The tripwire's second half (OPE-348 follow-up, John-approved 2026-08-11).
 *
 * `decideNewsletterMissing` watches COMPOSE. That leaves a real hole: an issue
 * composed and never sent passes it silently, and this is not hypothetical —
 * on 2026-08-11 production held two composed issues with `sent_at = NULL`
 * (`e9dfc329`, created 08-10, and `e6c2496c`, created 07-20).
 *
 * The ticket asked for a tripwire because "the customer-facing send deserves a
 * dedicated one", and compose is not the customer-facing event. A subscriber
 * cannot read a draft.
 *
 * Separate from the compose check rather than folded into it, because the two
 * failures have different causes and different fixes: compose failing means the
 * agent layer did not run; send failing means the agent ran and the delivery
 * path broke. Merging them would produce an alert that cannot tell you which.
 */
export function decideNewsletterUnsent(
  now: Date,
  latestIssue: { createdAt: Date; sentAt: Date | null } | null,
  lookbackMs: number = NEWSLETTER_LOOKBACK_MS
): boolean {
  if (now.getUTCDay() !== FRIDAY) return false;
  if (!latestIssue) return false; // the compose check owns "nothing exists"
  // Only complain once the issue has had a fair chance to go out. Composed
  // this morning and not yet sent is normal; composed and still unsent past
  // the lookback is the failure.
  if (now.getTime() - latestIssue.createdAt.getTime() <= lookbackMs) return false;
  return latestIssue.sentAt === null;
}

/**
 * Daily liveness check. Never throws — a watchdog that can crash is one that
 * stops watching, and this one has no watcher of its own.
 */
export async function runAgentSilenceWatchdog(
  env: WatchdogEnv,
  options: WatchdogRunOptions = {}
): Promise<WatchdogRunResult> {
  const db = getDb(env.DB);
  const now = options.now ?? new Date();
  const drill = options.drill === true;
  const dryRun = options.dryRun === true;

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
    return {
      silent: false,
      newsletterMissing: false,
      newsletterUnsent: false,
      alerted: false,
      subject: null,
      recipients: null,
      newestSeenAt: null,
      staleHours: null,
      agentCode: null,
      drill,
      dryRun,
    };
  }

  const verdict = decideSilence(newest, now, options.thresholdMs);

  // Newsletter tripwire — a separate question from agent liveness, because the
  // compose can fail on its own while everything else runs.
  let newsletterMissing = false;
  let newsletterUnsent = false;
  try {
    const [issue] = await db
      .select({ createdAt: newsletterIssues.createdAt, sentAt: newsletterIssues.sentAt })
      .from(newsletterIssues)
      .orderBy(desc(newsletterIssues.createdAt))
      .limit(1);
    newsletterMissing = decideNewsletterMissing(now, issue?.createdAt ?? null);
    // OPE-348 follow-up — composed is not sent. A subscriber cannot read a draft.
    newsletterUnsent = decideNewsletterUnsent(
      now,
      issue?.createdAt ? { createdAt: issue.createdAt, sentAt: issue.sentAt ?? null } : null
    );
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "[agent-silence] newsletter check failed",
      error,
    });
  }

  let alerted = false;
  let subject: string | null = null;
  const recipients = env.ALERT_EMAIL_TECHNICAL ?? null;

  if (verdict.silent || newsletterMissing || newsletterUnsent) {
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
    if (newsletterUnsent) {
      lines.push(
        "Newsletter: this week's issue was COMPOSED but never sent (sent_at is null). " +
          "The compose ran; the delivery did not. Subscribers have received nothing."
      );
    }
    // The `[DRILL]` prefix is the ONLY textual difference between a rehearsal
    // and the real thing. Sending an unmarked "agent layer silent" alarm while
    // the agent layer is demonstrably alive would manufacture a false alarm in
    // the operator's real inbox — the thing that trains people to ignore the
    // alert. One token of honesty is cheaper than that.
    subject =
      (drill ? "[DRILL] " : "") +
      (verdict.silent
        ? `🚨 Agent layer silent for ${verdict.staleHours}h`
        : newsletterMissing
          ? "🚨 Newsletter not composed this week"
          : "🚨 Newsletter composed but NOT SENT");

    const to = env.ALERT_EMAIL_TECHNICAL;
    if (dryRun) {
      console.log(`[cron] agent-silence dry-run — would alert: ${subject} → ${to ?? "(unset)"}`);
      return {
        silent: verdict.silent,
        newsletterMissing,
        newsletterUnsent,
        alerted: false,
        subject,
        recipients,
        newestSeenAt: verdict.newestSeenAt?.toISOString() ?? null,
        staleHours: verdict.staleHours,
        agentCode: verdict.agentCode,
        drill,
        dryRun,
      };
    }
    if (to && env.EMAIL_JOBS) {
      try {
        await env.EMAIL_JOBS.send({
          to,
          subject,
          text: `${lines.join("\n\n")}\n\nSent by the Cloudflare watchdog, which has no Anthropic dependency.\n`,
          html: `<p><strong>${subject}</strong></p>${lines.map((l) => `<p>${l}</p>`).join("")}<p style="color:#666;font-size:12px">Sent by the Cloudflare watchdog, which has no Anthropic dependency.</p>`,
          source: "agent-silence-watchdog",
        });
        alerted = true;
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
  //
  // A DRILL never stamps. The row carries an injected clock and a synthetic
  // verdict, so writing it would push the watchdog's own `last_seen_at` into
  // the future and record `note='alerted'` for an outage that did not happen —
  // corrupting precisely the evidence trail this ticket exists to establish.
  // Rehearsing the alarm must leave no trace in the data it watches.
  if (drill) {
    return {
      silent: verdict.silent,
      newsletterMissing,
      newsletterUnsent,
      alerted,
      subject,
      recipients,
      newestSeenAt: verdict.newestSeenAt?.toISOString() ?? null,
      staleHours: verdict.staleHours,
      agentCode: verdict.agentCode,
      drill,
      dryRun,
    };
  }

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

  return {
    silent: verdict.silent,
    newsletterMissing,
    newsletterUnsent,
    alerted,
    subject,
    recipients,
    newestSeenAt: verdict.newestSeenAt?.toISOString() ?? null,
    staleHours: verdict.staleHours,
    agentCode: verdict.agentCode,
    drill,
    dryRun,
  };
}
