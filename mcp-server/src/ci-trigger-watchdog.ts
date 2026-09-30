/**
 * OPE-1239 — a merge to main whose `push` event never fires is never deployed.
 *
 * deploy.yml runs only when CI completes, and its gate (scripts/deploy-gate.mjs)
 * accepts only a PUSH-triggered CI run. On 2026-09-28 two squash merges
 * (53c888a9, bfd9dcdd) produced no push CI run at all, so neither deployed
 * until something else carried it — from outside, exactly a slow pipeline.
 *
 * OPE-1227 put this check in a GitHub scheduled workflow, but GitHub runs this
 * repo's schedules hours apart (uptime-monitor.yml, every 30 min, ran three
 * times on 2026-09-30). This Worker's crons run on time, so the check lives here
 * and the workflow stays as a second, best-effort look.
 *
 * It ALERTS; it never deploys. A manual deploy.yml dispatch bypasses the CI
 * gate, so that stays a person's call — the recovery commands are in the email.
 *
 * The repo is public, so the GitHub API needs no token. Unauthenticated calls
 * share a 60/hour limit per egress IP, so a throttled or failed call is an
 * `unknown` and never an alert. An optional GITHUB_TOKEN secret lifts the limit.
 */
import { and, desc, eq, gt } from "drizzle-orm";
import { adminActions, tunableThresholds } from "./schema.js";
import { getDb, type Db } from "./db.js";
import type { Env } from "./index.js";
import { logError } from "./logger.js";

const SOURCE = "mcp:schedule:ci-trigger-watchdog";
export const CI_WATCHDOG_REPO = "JohnTarbox/takemetothefair-cloudflare";
export const CI_WATCHDOG_GRACE_KEY = "ci_trigger_watchdog_grace_minutes";
export const CI_WATCHDOG_DEFAULT_GRACE_MINUTES = 15;
/** Heartbeat evidence — at most one row an hour, so a 10-minute cron is not 144 rows a day. */
export const CI_WATCHDOG_RUN_ACTION = "ci.trigger_watchdog.run";
export const CI_WATCHDOG_ALERT_ACTION = "ci.trigger_watchdog.alert";
const RUN_STAMP_EVERY_MS = 60 * 60 * 1000;

export type CiTriggerVerdict = "ok" | "grace" | "missing" | "unknown";

/**
 * Pure. `pushRuns` is null when the API could not say (rate-limited, non-200,
 * network error) — that is `unknown`, never `missing`.
 */
export function decideCiTrigger(input: {
  committedAt: Date | null;
  pushRuns: number | null;
  now: Date;
  graceMinutes: number;
}): { verdict: CiTriggerVerdict; ageMinutes: number | null } {
  if (input.committedAt === null || input.pushRuns === null) {
    return { verdict: "unknown", ageMinutes: null };
  }
  const ageMinutes = Math.floor((input.now.getTime() - input.committedAt.getTime()) / 60_000);
  if (input.pushRuns > 0) return { verdict: "ok", ageMinutes };
  if (ageMinutes < input.graceMinutes) return { verdict: "grace", ageMinutes };
  return { verdict: "missing", ageMinutes };
}

export async function loadGraceMinutes(db: Db): Promise<number> {
  try {
    const [row] = await db
      .select({ value: tunableThresholds.value })
      .from(tunableThresholds)
      .where(eq(tunableThresholds.key, CI_WATCHDOG_GRACE_KEY))
      .limit(1);
    const v = row?.value;
    return typeof v === "number" && v > 0 ? v : CI_WATCHDOG_DEFAULT_GRACE_MINUTES;
  } catch {
    return CI_WATCHDOG_DEFAULT_GRACE_MINUTES;
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Main's HEAD and its push-CI run count. Any failure → nulls (→ `unknown`). */
export async function readMainHead(
  fetchImpl: FetchLike,
  token?: string
): Promise<{
  sha: string | null;
  committedAt: Date | null;
  pushRuns: number | null;
  note: string;
}> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "meetmeatthefair-mcp-ci-watchdog",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const api = `https://api.github.com/repos/${CI_WATCHDOG_REPO}`;
  try {
    const c = await fetchImpl(`${api}/commits/main`, { headers });
    if (!c.ok)
      return { sha: null, committedAt: null, pushRuns: null, note: `commits HTTP ${c.status}` };
    const commit = (await c.json()) as { sha?: string; commit?: { committer?: { date?: string } } };
    const sha = commit.sha ?? null;
    const date = commit.commit?.committer?.date;
    if (!sha || !date) return { sha, committedAt: null, pushRuns: null, note: "commit shape" };
    const r = await fetchImpl(
      `${api}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=1`,
      { headers }
    );
    if (!r.ok)
      return { sha, committedAt: new Date(date), pushRuns: null, note: `runs HTTP ${r.status}` };
    const runs = (await r.json()) as { total_count?: number };
    return {
      sha,
      committedAt: new Date(date),
      pushRuns: typeof runs.total_count === "number" ? runs.total_count : null,
      note: "ok",
    };
  } catch (err) {
    return {
      sha: null,
      committedAt: null,
      pushRuns: null,
      note: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface CiWatchdogResult {
  sha: string | null;
  verdict: CiTriggerVerdict;
  ageMinutes: number | null;
  alerted: boolean;
  note: string;
}

type CiWatchdogEnv = Pick<Env, "DB" | "EMAIL_JOBS" | "ALERT_EMAIL_TECHNICAL"> & {
  GITHUB_TOKEN?: string;
};

export async function runCiTriggerWatchdog(
  db: Db,
  env: Omit<CiWatchdogEnv, "DB">,
  deps: { fetchImpl?: FetchLike; now?: Date } = {}
): Promise<CiWatchdogResult> {
  const now = deps.now ?? new Date();
  const head = await readMainHead(deps.fetchImpl ?? fetch, env.GITHUB_TOKEN);
  const graceMinutes = await loadGraceMinutes(db);
  const { verdict, ageMinutes } = decideCiTrigger({
    committedAt: head.committedAt,
    pushRuns: head.pushRuns,
    now,
    graceMinutes,
  });

  let alerted = false;
  if (verdict === "missing" && head.sha) {
    // Once per SHA: a stuck commit must not email every ten minutes.
    const [already] = await db
      .select({ id: adminActions.id })
      .from(adminActions)
      .where(
        and(eq(adminActions.action, CI_WATCHDOG_ALERT_ACTION), eq(adminActions.targetId, head.sha))
      )
      .limit(1);
    if (!already) {
      const subject = `🚨 main ${head.sha.slice(0, 8)} has no push CI run — not deployed (${ageMinutes}m)`;
      const recovery = [
        `main's HEAD ${head.sha} was committed ${ageMinutes} minutes ago and has NO push-triggered CI run, so deploy.yml never ran for it.`,
        `Recover: gh workflow run ci.yml --ref main   (evidence it is green), then once green:`,
        `gh workflow run deploy.yml --ref main -f reason='push event for ${head.sha} never fired (OPE-1239 watchdog)'`,
        `If another merge lands first, its push CI deploys main's HEAD and carries this commit.`,
      ];
      if (env.ALERT_EMAIL_TECHNICAL && env.EMAIL_JOBS) {
        try {
          await env.EMAIL_JOBS.send({
            to: env.ALERT_EMAIL_TECHNICAL,
            subject,
            text: `${recovery.join("\n\n")}\n\nSent by the Cloudflare CI-trigger watchdog (OPE-1239).\n`,
            html: `<p><strong>${subject}</strong></p>${recovery.map((l) => `<p>${l}</p>`).join("")}`,
            source: "ci-trigger-watchdog",
          });
          alerted = true;
        } catch (error) {
          await logError(db, { source: SOURCE, message: "ci-trigger alert enqueue failed", error });
        }
      } else {
        await logError(db, {
          level: "warn",
          source: SOURCE,
          message: `would alert (${subject}) but ALERT_EMAIL_TECHNICAL/EMAIL_JOBS not configured`,
        });
      }
      if (alerted) {
        await db.insert(adminActions).values({
          action: CI_WATCHDOG_ALERT_ACTION,
          targetType: "COMMIT",
          targetId: head.sha,
          payloadJson: JSON.stringify({ ageMinutes, graceMinutes }),
          createdAt: now,
        });
      }
    }
  }

  // Heartbeat evidence LAST, so a crash above never reads as a healthy run —
  // and at most hourly: the probe needs liveness, not every tick.
  const [recent] = await db
    .select({ id: adminActions.id })
    .from(adminActions)
    .where(
      and(
        eq(adminActions.action, CI_WATCHDOG_RUN_ACTION),
        gt(adminActions.createdAt, new Date(now.getTime() - RUN_STAMP_EVERY_MS))
      )
    )
    .orderBy(desc(adminActions.createdAt))
    .limit(1);
  if (!recent) {
    await db.insert(adminActions).values({
      action: CI_WATCHDOG_RUN_ACTION,
      targetType: "COMMIT",
      targetId: head.sha ?? "unknown",
      payloadJson: JSON.stringify({ verdict, ageMinutes, note: head.note }),
      createdAt: now,
    });
  }

  return { sha: head.sha, verdict, ageMinutes, alerted, note: head.note };
}

export async function runScheduledCiTriggerWatchdog(env: CiWatchdogEnv): Promise<void> {
  try {
    const r = await runCiTriggerWatchdog(getDb(env.DB), env);
    console.log(
      `[cron] ci-trigger-watchdog ${r.verdict} sha=${r.sha?.slice(0, 8) ?? "?"} age=${r.ageMinutes ?? "?"}m alerted=${r.alerted} (${r.note})`
    );
  } catch (error) {
    await logError(env.DB, { source: SOURCE, message: "ci-trigger-watchdog run failed", error });
  }
}
