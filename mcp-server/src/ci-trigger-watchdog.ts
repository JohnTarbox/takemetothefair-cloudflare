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
 *
 * OPE-1239 rework (review return 2026-10-04). Two false "not deployed" emails
 * (bcc76d0c 10-01 08:00, dbfe34d1 10-02 07:10): each SHA had read `ok` several
 * times in the hours before, then the runs lookup answered 200 with
 * total_count 0. That is not a throttle, so it was not `unknown` — GitHub's
 * runs search simply came back empty once. So:
 *   1. an `ok` once seen for a SHA STICKS — a later zero for it is `unknown`;
 *   2. `missing` must be seen on two ticks ≥ CONFIRM_MS apart before it emails;
 *   3. 35 of 90 runs were blind (commits HTTP 403) and the hourly heartbeat
 *      counted them healthy, so a stretch with no real answer for BLIND_MS
 *      emails once that the watchdog itself is blind.
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
/** Written once per SHA the first time it reads `ok`; later zeros for it are noise. */
export const CI_WATCHDOG_SEEN_OK_ACTION = "ci.trigger_watchdog.seen_ok";
/** Written on the first `missing` for a SHA; the alert needs a second sighting. */
export const CI_WATCHDOG_SUSPECT_ACTION = "ci.trigger_watchdog.suspect";
/** At most hourly, whenever the API gave a real answer (any verdict but `unknown`). */
export const CI_WATCHDOG_READ_OK_ACTION = "ci.trigger_watchdog.read_ok";
export const CI_WATCHDOG_BLIND_ALERT_ACTION = "ci.trigger_watchdog.blind_alert";
const RUN_STAMP_EVERY_MS = 60 * 60 * 1000;
/** A second `missing` must come at least this long after the first (the cron is every 10m). */
export const CI_WATCHDOG_CONFIRM_MS = 9 * 60 * 1000;
/** No real answer from GitHub for this long → the watchdog is blind; say so once a day. */
export const CI_WATCHDOG_BLIND_MS = 6 * 60 * 60 * 1000;
const BLIND_ALERT_EVERY_MS = 24 * 60 * 60 * 1000;

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

async function latestRow(db: Db, action: string, targetId?: string) {
  const [row] = await db
    .select({ id: adminActions.id, createdAt: adminActions.createdAt })
    .from(adminActions)
    .where(
      targetId
        ? and(eq(adminActions.action, action), eq(adminActions.targetId, targetId))
        : eq(adminActions.action, action)
    )
    .orderBy(desc(adminActions.createdAt))
    .limit(1);
  return row ?? null;
}

async function stamp(db: Db, action: string, targetId: string, payload: unknown, now: Date) {
  await db.insert(adminActions).values({
    action,
    targetType: "COMMIT",
    targetId,
    payloadJson: JSON.stringify(payload),
    createdAt: now,
  });
}

export async function runCiTriggerWatchdog(
  db: Db,
  env: Omit<CiWatchdogEnv, "DB">,
  deps: { fetchImpl?: FetchLike; now?: Date } = {}
): Promise<CiWatchdogResult> {
  const now = deps.now ?? new Date();
  const head = await readMainHead(deps.fetchImpl ?? fetch, env.GITHUB_TOKEN);
  const graceMinutes = await loadGraceMinutes(db);
  const decided = decideCiTrigger({
    committedAt: head.committedAt,
    pushRuns: head.pushRuns,
    now,
    graceMinutes,
  });
  let { verdict } = decided;
  const { ageMinutes } = decided;
  let note = head.note;

  // (1) An `ok` sticks. Record the first one; a later zero for that SHA is the
  // runs search misbehaving, not the push event disappearing after the fact.
  if (head.sha && verdict === "ok") {
    if (!(await latestRow(db, CI_WATCHDOG_SEEN_OK_ACTION, head.sha))) {
      await stamp(db, CI_WATCHDOG_SEEN_OK_ACTION, head.sha, { ageMinutes }, now);
    }
  } else if (head.sha && verdict === "missing") {
    if (await latestRow(db, CI_WATCHDOG_SEEN_OK_ACTION, head.sha)) {
      verdict = "unknown";
      note = "runs lookup returned 0 for a SHA already seen ok";
    }
  }

  // (3) Any real answer from GitHub resets the blind clock (hourly row at most).
  if (verdict !== "unknown") {
    const lastRead = await latestRow(db, CI_WATCHDOG_READ_OK_ACTION);
    if (!lastRead || now.getTime() - lastRead.createdAt.getTime() >= RUN_STAMP_EVERY_MS) {
      await stamp(db, CI_WATCHDOG_READ_OK_ACTION, head.sha ?? "unknown", { verdict }, now);
    }
  }

  let alerted = false;
  // (2) `missing` must be seen twice, CONFIRM_MS apart, before it emails.
  let confirmed = false;
  if (verdict === "missing" && head.sha) {
    const suspect = await latestRow(db, CI_WATCHDOG_SUSPECT_ACTION, head.sha);
    if (!suspect) {
      await stamp(db, CI_WATCHDOG_SUSPECT_ACTION, head.sha, { ageMinutes }, now);
      note = "missing (first sighting; alerts if still missing next run)";
    } else if (now.getTime() - suspect.createdAt.getTime() >= CI_WATCHDOG_CONFIRM_MS) {
      confirmed = true;
    }
  }
  if (confirmed && head.sha) {
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

  // (3) Blind: there WAS a real answer once, and none for BLIND_MS since. Only
  // after a first real read, so a fresh deploy cannot alarm on its own start.
  if (verdict === "unknown") {
    const lastRead = await latestRow(db, CI_WATCHDOG_READ_OK_ACTION);
    const blindForMs = lastRead ? now.getTime() - lastRead.createdAt.getTime() : 0;
    if (lastRead && blindForMs >= CI_WATCHDOG_BLIND_MS) {
      const lastBlind = await latestRow(db, CI_WATCHDOG_BLIND_ALERT_ACTION);
      if (!lastBlind || now.getTime() - lastBlind.createdAt.getTime() >= BLIND_ALERT_EVERY_MS) {
        const hours = Math.floor(blindForMs / 3_600_000);
        const subject = `⚠️ CI-trigger watchdog is blind — no answer from GitHub for ${hours}h`;
        const body = [
          `The watchdog has not had a real answer from the GitHub API for ${hours} hours (last: ${head.note}). While blind it cannot tell you a merge went undeployed.`,
          `Usual cause: the unauthenticated 60/hour limit is shared with other Cloudflare egress. Fix: add a read-only GITHUB_TOKEN secret to the meetmeatthefair-mcp Worker (wrangler secret put GITHUB_TOKEN).`,
          `Check main by hand meanwhile: gh run list --workflow ci.yml --branch main --event push --limit 3`,
        ];
        if (env.ALERT_EMAIL_TECHNICAL && env.EMAIL_JOBS) {
          try {
            await env.EMAIL_JOBS.send({
              to: env.ALERT_EMAIL_TECHNICAL,
              subject,
              text: `${body.join("\n\n")}\n\nSent by the Cloudflare CI-trigger watchdog (OPE-1239).\n`,
              html: `<p><strong>${subject}</strong></p>${body.map((l) => `<p>${l}</p>`).join("")}`,
              source: "ci-trigger-watchdog",
            });
            await stamp(db, CI_WATCHDOG_BLIND_ALERT_ACTION, "watchdog", { hours }, now);
            alerted = true;
          } catch (error) {
            await logError(db, { source: SOURCE, message: "ci-trigger blind alert failed", error });
          }
        }
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
      payloadJson: JSON.stringify({ verdict, ageMinutes, note }),
      createdAt: now,
    });
  }

  return { sha: head.sha, verdict, ageMinutes, alerted, note };
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
