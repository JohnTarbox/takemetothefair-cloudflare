/**
 * OPE-1637 step 6 — the hourly "is Battleship up?" alarm.
 *
 * The daily agent-silence watchdog (agent-silence-watchdog.ts) answers "are agent
 * SESSIONS running?" at a 26h threshold. That is too slow for "the developer
 * machine is down": on 2026-11-11 a Windows Update restart left Battleship at the
 * lock screen for 11h54m and 24 queue runs were missed before anyone noticed.
 *
 * The signal here is different on purpose. `~/open-engine/queue-cron.sh` stamps a
 * HOST row on every cron fire — including the fires that skip because a long
 * drain still holds the lane's lock — so the row goes stale only when cron itself
 * stops, i.e. when Battleship or WSL is down. (A session-written heartbeat would
 * false-alarm on every drain longer than the threshold: the cron log held 122
 * "previous run still holds" skips when this was built.)
 *
 * Kept OFF the rows the daily watchdog reads:
 *  - host stamps are `agent_code='host:<lane>'`, `kind='host'`. The daily
 *    watchdog filters `kind='agent'`. If the wrapper wrote `kind='agent'`, a
 *    quota outage (cron fires, every Claude session dies) would read as healthy.
 *    That is the exact failure OPE-348 exists for.
 *  - this watcher's own run stamp is `watchdog:host-silence`, and its `note`
 *    carries the alert state (`ok` | `silent` | `dormant`). That is how it emails
 *    exactly once on going silent and once on clearing, with no new table.
 *
 * Dormant until the first host stamp lands: before the wrapper has a token there
 * is no row, and "no row" must not page John on deploy day. The dormant state is
 * written into the stamp's note, so it is visible rather than silent.
 */
import { inArray } from "drizzle-orm";
import { agentHeartbeats } from "./schema.js";
import { getDb } from "./db.js";
import { logError } from "./logger.js";

/** The lanes whose host the wrapper stamps. Only these may be stamped (narrow token). */
export const HOST_WATCHED_LANES = ["developer-claude-code"] as const;
export type HostWatchedLane = (typeof HOST_WATCHED_LANES)[number];

export const HOST_KIND = "host";
export const hostCode = (lane: string) => `host:${lane}`;

/** This watcher's own run stamp (OPE-246 evidence + alert state). */
export const HOST_WATCH_CODE = "watchdog:host-silence";

/**
 * 75 min = two missed 30-min cron fires plus 15 min of slack (John, OPE-1637).
 * Checked hourly, so detection lands 75–135 min after the last fire.
 */
export const HOST_SILENCE_THRESHOLD_MS = 75 * 60 * 1000;

export type HostState = "ok" | "silent" | "dormant";

export interface HostWatchEnv {
  DB: D1Database;
  EMAIL_JOBS?: Queue;
  ALERT_EMAIL_TECHNICAL?: string;
}

export interface HostLaneVerdict {
  lane: string;
  state: HostState;
  lastSeenAt: string | null;
  staleMinutes: number | null;
}

/** Pure: one lane's state from its newest host stamp. */
export function decideHostState(
  lastSeenAt: Date | null,
  now: Date,
  thresholdMs: number = HOST_SILENCE_THRESHOLD_MS
): { state: HostState; staleMinutes: number | null } {
  if (!lastSeenAt) return { state: "dormant", staleMinutes: null };
  const staleMs = now.getTime() - lastSeenAt.getTime();
  return {
    state: staleMs > thresholdMs ? "silent" : "ok",
    staleMinutes: Math.round(staleMs / 60_000),
  };
}

/**
 * The previous run's per-lane states, from the stamp note. Format:
 * `developer-claude-code=ok;other=silent`. Unparseable → treated as unknown,
 * which never sends a "cleared" mail for an alarm that was never raised.
 */
export function parseStampNote(note: string | null | undefined): Map<string, HostState> {
  const out = new Map<string, HostState>();
  for (const part of (note ?? "").split(";")) {
    const [lane, state] = part.split("=");
    if (lane && (state === "ok" || state === "silent" || state === "dormant")) {
      out.set(lane, state);
    }
  }
  return out;
}

export const formatStampNote = (verdicts: readonly HostLaneVerdict[]) =>
  verdicts.map((v) => `${v.lane}=${v.state}`).join(";");

/** Which transitions mail John. Exactly two: into silent, and out of it. */
export function transitionToMail(
  prev: HostState | undefined,
  next: HostState
): "silent" | "cleared" | null {
  if (next === "silent" && prev !== "silent") return "silent";
  if (prev === "silent" && next === "ok") return "cleared";
  return null;
}

export interface HostWatchResult {
  verdicts: HostLaneVerdict[];
  mailed: Array<{ lane: string; kind: "silent" | "cleared"; subject: string }>;
}

export async function runHostSilenceWatch(
  env: HostWatchEnv,
  options: { now?: Date; thresholdMs?: number } = {}
): Promise<HostWatchResult> {
  const now = options.now ?? new Date();
  const db = getDb(env.DB);

  const rows = await db
    .select({
      agentCode: agentHeartbeats.agentCode,
      lastSeenAt: agentHeartbeats.lastSeenAt,
      note: agentHeartbeats.note,
    })
    .from(agentHeartbeats)
    .where(
      inArray(agentHeartbeats.agentCode, [...HOST_WATCHED_LANES.map(hostCode), HOST_WATCH_CODE])
    );
  const byCode = new Map(rows.map((r) => [r.agentCode, r]));
  const prev = parseStampNote(byCode.get(HOST_WATCH_CODE)?.note);

  const verdicts: HostLaneVerdict[] = HOST_WATCHED_LANES.map((lane) => {
    const seen = byCode.get(hostCode(lane))?.lastSeenAt ?? null;
    const { state, staleMinutes } = decideHostState(seen, now, options.thresholdMs);
    return { lane, state, lastSeenAt: seen?.toISOString() ?? null, staleMinutes };
  });

  const mailed: HostWatchResult["mailed"] = [];
  for (const v of verdicts) {
    const kind = transitionToMail(prev.get(v.lane), v.state);
    if (!kind) continue;
    const subject =
      kind === "silent"
        ? `🚨 ${v.lane} host silent ${v.staleMinutes} min (Battleship or WSL down?)`
        : `✅ ${v.lane} host is back (cron firing again)`;
    const body =
      kind === "silent"
        ? [
            `No cron fire from ${v.lane}'s host for ${v.staleMinutes} minutes (threshold 75). Last stamp: ${v.lastSeenAt}.`,
            "queue-cron.sh stamps on every 30-minute fire, including fires skipped by a long run, so this means cron itself is not running: Battleship is off, at the lock screen after a restart, or WSL is stopped.",
            "You'll get one more mail when it clears. (OPE-1637)",
          ]
        : [`${v.lane}'s host stamped again at ${v.lastSeenAt}. The cron is firing.`, "(OPE-1637)"];
    if (!env.ALERT_EMAIL_TECHNICAL || !env.EMAIL_JOBS) {
      await logError(env.DB, {
        level: "warn",
        source: "mcp:schedule:host-silence-watch",
        message: `[host-silence] would mail (${subject}) but ALERT_EMAIL_TECHNICAL/EMAIL_JOBS not configured`,
      });
      // Keep the previous state so the mail is retried next hour rather than lost.
      v.state = prev.get(v.lane) ?? "dormant";
      continue;
    }
    try {
      await env.EMAIL_JOBS.send({
        to: env.ALERT_EMAIL_TECHNICAL,
        subject,
        text: `${body.join("\n\n")}\n\nSent by the Cloudflare host-silence watch, which does not run on Battleship.\n`,
        html: `<p><strong>${subject}</strong></p>${body.map((l) => `<p>${l}</p>`).join("")}`,
        source: "host-silence-watch",
      });
      mailed.push({ lane: v.lane, kind, subject });
    } catch (error) {
      await logError(env.DB, {
        source: "mcp:schedule:host-silence-watch",
        message: "[host-silence] alert enqueue failed",
        error,
      });
      v.state = prev.get(v.lane) ?? "dormant"; // retry next hour
    }
  }

  // Stamp LAST, so a crash above never looks like a healthy run.
  await db
    .insert(agentHeartbeats)
    .values({
      id: crypto.randomUUID(),
      agentCode: HOST_WATCH_CODE,
      kind: "watchdog",
      lastSeenAt: now,
      note: formatStampNote(verdicts),
    })
    .onConflictDoUpdate({
      target: agentHeartbeats.agentCode,
      set: { lastSeenAt: now, kind: "watchdog", note: formatStampNote(verdicts) },
    });

  console.log(
    `[cron] host-silence ${formatStampNote(verdicts)}; mailed ${mailed.length}` +
      (verdicts.some((v) => v.state === "dormant") ? " (dormant = no host stamp yet)" : "")
  );
  return { verdicts, mailed };
}

/**
 * The write behind `POST /host-heartbeat`. Only `host:<watched lane>` rows with
 * kind='host' can be written — the token cannot touch a `kind='agent'` row, so it
 * cannot keep the daily watchdog quiet.
 */
export async function recordHostHeartbeat(
  d1: D1Database,
  lane: HostWatchedLane,
  note: string | null,
  now: Date = new Date()
): Promise<void> {
  await getDb(d1)
    .insert(agentHeartbeats)
    .values({
      id: crypto.randomUUID(),
      agentCode: hostCode(lane),
      kind: HOST_KIND,
      lastSeenAt: now,
      note,
    })
    .onConflictDoUpdate({
      target: agentHeartbeats.agentCode,
      set: { lastSeenAt: now, kind: HOST_KIND, note },
    });
}

export const isWatchedLane = (lane: unknown): lane is HostWatchedLane =>
  typeof lane === "string" && (HOST_WATCHED_LANES as readonly string[]).includes(lane);
