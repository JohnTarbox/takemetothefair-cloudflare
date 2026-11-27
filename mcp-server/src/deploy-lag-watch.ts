/**
 * OPE-1655 — the hourly "is production behind main?" alarm.
 *
 * From 2026-11-13 main's CI was red (OPE-1652), so deploy.yml's gate skipped
 * every deploy and each run still read "success". Production sat on 00f6c96 for
 * three days with merged PRs undeployed (#1800, #1790) and nothing alerted —
 * the developer found it by trying to use a tool argument that was not live.
 * deploy.yml now fails loudly on such a skip, but that is a signal INSIDE GitHub,
 * from the same system that failed. This check runs on Cloudflare's cron, which
 * fires on time (OPE-1239), and measures the outcome directly: the SHA each
 * Worker is actually running, against main's HEAD.
 *
 *   - MCP Worker: `env.GIT_SHA` — this code IS the MCP Worker, so its own var is
 *     the live build (deploy.yml stamps it with `--var GIT_SHA`).
 *   - Main app: `gitSha` from https://meetmeatthefair.com/api/health (also
 *     stamped by deploy.yml, OPE-1655). Before the first deploy that carries it,
 *     the app reads "unknown" and only the MCP Worker is judged — said in the note.
 *
 * Lag is measured from the OLDEST undeployed commit (GitHub compare API, squash
 * merges carry their merge time), not from main's HEAD: a merge every hour would
 * keep HEAD young forever while production never moves.
 *
 * Exactly one email when lag crosses 2h and one when it clears, with the state
 * held in this watch's own `watchdog:deploy-lag` stamp note (the OPE-1637
 * pattern; no new table). While lagging, every run also logs one `[deploy-lag]`
 * error row: the hourly fault emitter turns that into a `fault_signatures` row
 * (CPI fault family FAM-DEPLOY-LAG), which the OPE-75 daily digest reports.
 *
 * GitHub failures are `unknown`, never an alert and never a "cleared": the repo is
 * public and unauthenticated calls share 60/hour per egress IP with the
 * ci-trigger-watchdog. An optional GITHUB_TOKEN lifts that.
 */
import { eq, sql } from "drizzle-orm";
import { agentHeartbeats } from "./schema.js";
import { getDb } from "./db.js";
import { logError } from "./logger.js";
import { CI_WATCHDOG_REPO } from "./ci-trigger-watchdog.js";
import { sendEmailJob } from "./email-jobs.js";

export const DEPLOY_LAG_WATCH_CODE = "watchdog:deploy-lag";
export const DEPLOY_LAG_SOURCE = "mcp:schedule:deploy-lag-watch";
/** 2h, per OPE-1655. Checked hourly, so detection lands 2–3h after the oldest undeployed merge. */
export const DEPLOY_LAG_THRESHOLD_MS = 2 * 60 * 60 * 1000;
export const APP_HEALTH_URL = "https://meetmeatthefair.com/api/health";
/** Stable text: the fault signature is built from it, so no numbers or SHAs here. */
export const DEPLOY_LAG_FAULT_MESSAGE =
  "[deploy-lag] production is behind main past the 2h threshold";

/**
 * OPE-1655 rework (John, 2026-11-16) — the watch went BLIND on its second tick
 * ever: `main=?` at 20:00Z, because the unauthenticated GitHub read shares 60/hour
 * per egress IP. By design an unknown neither raises nor clears, so every blind
 * tick is a tick where a deploy freeze is invisible — the failure this watch
 * exists for, hidden by the watch itself. After more than this many CONSECUTIVE
 * hourly ticks without main's HEAD, the blindness is itself the alarm.
 */
export const BLIND_TICKS_THRESHOLD = 3;
/**
 * Stable text for the fault row (no numbers). Classified as
 * FAM-DEPLOY-LAG-WATCH-BLIND, which sits BEFORE FAM-DEPLOY-LAG in the
 * first-match-wins registry — this message also contains "deploy-lag".
 */
export const DEPLOY_LAG_BLIND_FAULT_MESSAGE =
  "[deploy-lag-watch-blind] the deploy-lag watch cannot read main's HEAD from GitHub";

export type LagState = "ok" | "lagging" | "unknown";
export type WorkerName = "mcp" | "app";

export interface WorkerLag {
  worker: WorkerName;
  liveSha: string | null;
  state: LagState;
  behindBy: number | null;
  oldestUndeployedAt: string | null;
  lagMinutes: number | null;
  note: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const SHA_RE = /^[0-9a-f]{7,40}$/;

/**
 * Pure. `behindBy` null = GitHub could not say → unknown. 0 = live is main.
 * Otherwise lagging once the oldest undeployed commit is older than the threshold.
 */
export function decideLag(input: {
  behindBy: number | null;
  oldestUndeployedAt: Date | null;
  now: Date;
  thresholdMs?: number;
}): { state: LagState; lagMinutes: number | null } {
  const threshold = input.thresholdMs ?? DEPLOY_LAG_THRESHOLD_MS;
  if (input.behindBy === null) return { state: "unknown", lagMinutes: null };
  if (input.behindBy === 0) return { state: "ok", lagMinutes: 0 };
  if (!input.oldestUndeployedAt) return { state: "unknown", lagMinutes: null };
  const lagMs = input.now.getTime() - input.oldestUndeployedAt.getTime();
  return {
    state: lagMs > threshold ? "lagging" : "ok",
    lagMinutes: Math.max(0, Math.round(lagMs / 60_000)),
  };
}

/** Any lagging worker → lagging; else ok if at least one worker gave a real answer. */
export function overallState(workers: readonly WorkerLag[]): LagState {
  if (workers.some((w) => w.state === "lagging")) return "lagging";
  if (workers.some((w) => w.state === "ok")) return "ok";
  return "unknown";
}

/** Exactly two transitions mail: into lagging, and out of it. `unknown` never mails. */
export function transitionToMail(
  prev: LagState | undefined,
  next: LagState
): "lagging" | "cleared" | null {
  if (next === "lagging" && prev !== "lagging") return "lagging";
  if (prev === "lagging" && next === "ok") return "cleared";
  return null;
}

/**
 * Why main's HEAD could not be read, compactly, for the stamp note: `403`,
 * `429`, `timeout`, `fetch`, `shape`. The note is the one place the cause is
 * readable without Workers Logs (OPE-1655 rework item 3).
 */
export function headFailureReason(note: string): string {
  const http = /HTTP (\d{3})/.exec(note);
  if (http) return http[1];
  if (/timed? ?out|timeout|abort/i.test(note)) return "timeout";
  if (/fetch failed/i.test(note)) return "fetch";
  if (/shape/i.test(note)) return "shape";
  return "unknown";
}

/** Consecutive blind ticks and whether the blind alarm has mailed, from the stamp note. */
export function parseBlindState(note: string | null | undefined): {
  blind: number;
  blindMailed: boolean;
} {
  const b = /(?:^|;)blind=(\d+)(?:;|$)/.exec(note ?? "");
  const m = /(?:^|;)blindmail=1(?:;|$)/.test(note ?? "");
  return { blind: b ? Number(b[1]) : 0, blindMailed: m };
}

/** Exactly two blind transitions mail: into blind (> threshold), and the first good read after. */
export function blindTransitionToMail(input: {
  blindMailed: boolean;
  blind: number;
  threshold?: number;
}): "blind" | "sighted" | null {
  const t = input.threshold ?? BLIND_TICKS_THRESHOLD;
  if (input.blind > t && !input.blindMailed) return "blind";
  if (input.blind === 0 && input.blindMailed) return "sighted";
  return null;
}

/** `state=<s>;mcp=<sha>;app=<sha>;main=<sha>;lag=<min>` → the alert state only. */
export function parseStampState(note: string | null | undefined): LagState | undefined {
  const m = /(?:^|;)state=(ok|lagging|unknown)(?:;|$)/.exec(note ?? "");
  return m ? (m[1] as LagState) : undefined;
}

function githubHeaders(token?: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "meetmeatthefair-mcp-deploy-lag-watch",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Main's HEAD SHA, or null with a reason. */
export async function readMainHeadSha(
  fetchImpl: FetchLike,
  token?: string
): Promise<{ sha: string | null; note: string }> {
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${CI_WATCHDOG_REPO}/commits/main`, {
      headers: githubHeaders(token),
    });
    if (!r.ok) return { sha: null, note: `commits HTTP ${r.status}` };
    const body = (await r.json()) as { sha?: string };
    return body.sha ? { sha: body.sha, note: "ok" } : { sha: null, note: "commit shape" };
  } catch (err) {
    return { sha: null, note: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * How far `liveSha` is behind main, and when the oldest commit it is missing
 * landed. Compare lists commits oldest-first; `ahead_by` counts what main has
 * that the live build does not.
 */
export async function compareLiveToMain(
  fetchImpl: FetchLike,
  liveSha: string,
  token?: string
): Promise<{ behindBy: number | null; oldestUndeployedAt: Date | null; note: string }> {
  try {
    const r = await fetchImpl(
      `https://api.github.com/repos/${CI_WATCHDOG_REPO}/compare/${liveSha}...main`,
      { headers: githubHeaders(token) }
    );
    if (!r.ok)
      return { behindBy: null, oldestUndeployedAt: null, note: `compare HTTP ${r.status}` };
    const body = (await r.json()) as {
      status?: string;
      ahead_by?: number;
      commits?: Array<{ commit?: { committer?: { date?: string } } }>;
    };
    if (typeof body.ahead_by !== "number") {
      return { behindBy: null, oldestUndeployedAt: null, note: "compare shape" };
    }
    if (body.ahead_by === 0)
      return { behindBy: 0, oldestUndeployedAt: null, note: body.status ?? "ok" };
    const date = body.commits?.[0]?.commit?.committer?.date;
    return {
      behindBy: body.ahead_by,
      oldestUndeployedAt: date ? new Date(date) : null,
      note: date ? "ok" : "compare: no commit date",
    };
  } catch (err) {
    return {
      behindBy: null,
      oldestUndeployedAt: null,
      note: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** The app's live SHA from /api/health, or null if absent / "unknown" / unreachable. */
export async function readAppLiveSha(
  fetchImpl: FetchLike
): Promise<{ sha: string | null; note: string }> {
  try {
    const r = await fetchImpl(APP_HEALTH_URL, {
      headers: { "User-Agent": "meetmeatthefair-mcp-deploy-lag-watch" },
    });
    const body = (await r.json().catch(() => ({}))) as { gitSha?: string };
    const sha = typeof body.gitSha === "string" ? body.gitSha.trim().toLowerCase() : "";
    if (SHA_RE.test(sha)) return { sha, note: "ok" };
    return {
      sha: null,
      note: `app gitSha ${JSON.stringify(body.gitSha ?? null)} (HTTP ${r.status})`,
    };
  } catch (err) {
    return {
      sha: null,
      note: `app health fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Migrations merged on main but not applied to prod D1. Only read when lagging
 * (one extra GitHub call). Null = could not tell.
 */
export async function readPendingMigrations(
  fetchImpl: FetchLike,
  d1: D1Database,
  token?: string
): Promise<string[] | null> {
  try {
    const r = await fetchImpl(
      `https://api.github.com/repos/${CI_WATCHDOG_REPO}/contents/drizzle?ref=main`,
      { headers: githubHeaders(token) }
    );
    if (!r.ok) return null;
    const entries = (await r.json()) as Array<{ name?: string; type?: string }>;
    if (!Array.isArray(entries)) return null;
    const onMain = entries
      .filter(
        (e) => e.type === "file" && typeof e.name === "string" && /^\d{4}_.*\.sql$/.test(e.name)
      )
      .map((e) => e.name as string);
    const applied = await getDb(d1).all<{ name: string }>(sql`SELECT name FROM d1_migrations`);
    const done = new Set(applied.map((a) => a.name));
    return onMain.filter((n) => !done.has(n)).sort();
  } catch {
    return null;
  }
}

export interface DeployLagEnv {
  DB: D1Database;
  GIT_SHA?: string;
  GITHUB_TOKEN?: string;
  EMAIL_JOBS?: Queue;
  ALERT_EMAIL_TECHNICAL?: string;
}

export interface DeployLagResult {
  state: LagState;
  /** Consecutive ticks without main's HEAD (0 when this tick read it). */
  blindTicks: number;
  blindMailed: "blind" | "sighted" | null;
  mainSha: string | null;
  workers: WorkerLag[];
  pendingMigrations: string[] | null;
  mailed: "lagging" | "cleared" | null;
  stampNote: string;
}

async function judgeWorker(
  worker: WorkerName,
  live: { sha: string | null; note: string },
  mainSha: string | null,
  fetchImpl: FetchLike,
  now: Date,
  token: string | undefined,
  thresholdMs: number | undefined
): Promise<WorkerLag> {
  const base = { worker, liveSha: live.sha };
  if (!live.sha) {
    return {
      ...base,
      state: "unknown",
      behindBy: null,
      oldestUndeployedAt: null,
      lagMinutes: null,
      note: live.note,
    };
  }
  if (!mainSha) {
    return {
      ...base,
      state: "unknown",
      behindBy: null,
      oldestUndeployedAt: null,
      lagMinutes: null,
      note: "main HEAD unknown",
    };
  }
  if (mainSha.startsWith(live.sha)) {
    return {
      ...base,
      state: "ok",
      behindBy: 0,
      oldestUndeployedAt: null,
      lagMinutes: 0,
      note: "live = main",
    };
  }
  const cmp = await compareLiveToMain(fetchImpl, live.sha, token);
  const d = decideLag({
    behindBy: cmp.behindBy,
    oldestUndeployedAt: cmp.oldestUndeployedAt,
    now,
    thresholdMs,
  });
  return {
    ...base,
    state: d.state,
    behindBy: cmp.behindBy,
    oldestUndeployedAt: cmp.oldestUndeployedAt?.toISOString() ?? null,
    lagMinutes: d.lagMinutes,
    note: cmp.note,
  };
}

function describe(w: WorkerLag): string {
  const name = w.worker === "mcp" ? "MCP Worker" : "main app";
  if (w.state === "unknown") return `${name}: live ${w.liveSha ?? "unknown"} (${w.note})`;
  if (w.behindBy === 0) return `${name}: live ${w.liveSha}, up to date`;
  return `${name}: live ${w.liveSha}, ${w.behindBy} commit(s) behind; oldest undeployed merged ${w.oldestUndeployedAt} (${w.lagMinutes} min ago)`;
}

export async function runDeployLagWatch(
  env: DeployLagEnv,
  options: { now?: Date; fetchImpl?: FetchLike; thresholdMs?: number } = {}
): Promise<DeployLagResult> {
  const now = options.now ?? new Date();
  const fetchImpl = options.fetchImpl ?? fetch;
  const db = getDb(env.DB);

  const [head, app] = await Promise.all([
    readMainHeadSha(fetchImpl, env.GITHUB_TOKEN),
    readAppLiveSha(fetchImpl),
  ]);
  const mcpSha = (env.GIT_SHA ?? "").trim().toLowerCase();
  const mcpLive = SHA_RE.test(mcpSha)
    ? { sha: mcpSha, note: "ok" }
    : { sha: null, note: `MCP GIT_SHA ${JSON.stringify(env.GIT_SHA ?? null)}` };

  const workers: WorkerLag[] = [];
  for (const [name, live] of [
    ["mcp", mcpLive],
    ["app", app],
  ] as const) {
    workers.push(
      await judgeWorker(name, live, head.sha, fetchImpl, now, env.GITHUB_TOKEN, options.thresholdMs)
    );
  }
  const state = overallState(workers);

  const [prevRow] = await db
    .select({ note: agentHeartbeats.note })
    .from(agentHeartbeats)
    .where(eq(agentHeartbeats.agentCode, DEPLOY_LAG_WATCH_CODE))
    .limit(1);
  const prev = parseStampState(prevRow?.note);
  // `unknown` carries the previous state forward: a GitHub hiccup must neither
  // raise nor clear the alarm.
  let recorded: LagState = state === "unknown" ? (prev ?? "unknown") : state;

  const pendingMigrations =
    state === "lagging" ? await readPendingMigrations(fetchImpl, env.DB, env.GITHUB_TOKEN) : null;
  const maxLag = Math.max(0, ...workers.map((w) => w.lagMinutes ?? 0));
  const lines = [
    `main HEAD: ${head.sha ?? `unknown (${head.note})`}`,
    ...workers.map(describe),
    pendingMigrations === null
      ? state === "lagging"
        ? "Pending migrations: could not read."
        : ""
      : pendingMigrations.length
        ? `Pending migrations (merged, not applied to prod D1): ${pendingMigrations.join(", ")}`
        : "Pending migrations: none.",
  ].filter(Boolean);

  if (state === "lagging") {
    // One error row per lagging run → fault_signatures (FAM-DEPLOY-LAG) → OPE-75 digest.
    await logError(env.DB, {
      source: DEPLOY_LAG_SOURCE,
      message: DEPLOY_LAG_FAULT_MESSAGE,
      context: { mainSha: head.sha, workers, pendingMigrations },
    });
  }

  let mailed: DeployLagResult["mailed"] = null;
  const kind = transitionToMail(prev, recorded);
  if (kind) {
    const subject =
      kind === "lagging"
        ? `🚨 Production is ${maxLag} min behind main (deploys not landing)`
        : `✅ Production caught up with main`;
    const body =
      kind === "lagging"
        ? [
            ...lines,
            "Merged commits have not reached production for over 2 hours. Usual causes: main's CI is red, so deploy.yml's gate skipped the deploy (that run now fails with \"Deploy skipped\"); or the deploy job itself failed. Check the latest Deploy to Cloudflare run on main.",
            "You'll get one more mail when production catches up. (OPE-1655)",
          ]
        : [...lines, "Every Worker that reported a SHA is on main's HEAD again. (OPE-1655)"];
    if (!env.ALERT_EMAIL_TECHNICAL || !env.EMAIL_JOBS) {
      await logError(env.DB, {
        level: "warn",
        source: DEPLOY_LAG_SOURCE,
        message: `[deploy-lag] would mail (${subject}) but ALERT_EMAIL_TECHNICAL/EMAIL_JOBS not configured`,
      });
      recorded = prev ?? "unknown"; // retry the mail next hour rather than lose it
    } else {
      try {
        await sendEmailJob(env.EMAIL_JOBS, env.DB, {
          to: env.ALERT_EMAIL_TECHNICAL,
          subject,
          text: `${body.join("\n\n")}\n\nSent by the Cloudflare deploy-lag watch (hourly, MCP Worker).\n`,
          html: `<p><strong>${subject}</strong></p>${body.map((l) => `<p>${l}</p>`).join("")}`,
          source: "deploy-lag-watch",
        });
        mailed = kind;
      } catch (error) {
        await logError(env.DB, {
          source: DEPLOY_LAG_SOURCE,
          message: "[deploy-lag] alert enqueue failed",
          error,
        });
        recorded = prev ?? "unknown";
      }
    }
  }

  // ── OPE-1655 rework: a watch that cannot read main is itself an alarm ──────
  const prevBlind = parseBlindState(prevRow?.note);
  const blind = head.sha ? 0 : prevBlind.blind + 1;
  let blindMailed = prevBlind.blindMailed;
  let blindSent: DeployLagResult["blindMailed"] = null;
  if (blind > BLIND_TICKS_THRESHOLD) {
    // One row per blind tick → fault_signatures (FAM-DEPLOY-LAG-WATCH-BLIND).
    await logError(env.DB, {
      source: DEPLOY_LAG_SOURCE,
      message: DEPLOY_LAG_BLIND_FAULT_MESSAGE,
      context: { blindTicks: blind, reason: head.note, tokenConfigured: Boolean(env.GITHUB_TOKEN) },
    });
  }
  const blindKind = blindTransitionToMail({ blindMailed, blind });
  if (blindKind) {
    const subject =
      blindKind === "blind"
        ? "⚠️ deploy-lag watch can't read main (production-lag alarm is blind)"
        : "✅ deploy-lag watch can read main again";
    const body =
      blindKind === "blind"
        ? [
            `The hourly deploy-lag watch has failed to read main's HEAD from GitHub for ${blind} consecutive ticks (last reason: ${head.note}).`,
            "While it is blind, a deploy freeze would NOT alert: an unreadable main neither raises nor clears the lag alarm.",
            env.GITHUB_TOKEN
              ? "A GITHUB_TOKEN is configured, so check that it is still valid (expired or revoked tokens return 401/403)."
              : "No GITHUB_TOKEN is configured, so the watch shares GitHub's 60/hour unauthenticated limit per egress IP. Add a fine-grained read-only token as the MCP Worker secret GITHUB_TOKEN.",
            "You'll get one more mail when a read succeeds. (OPE-1655)",
          ]
        : [`main HEAD read again: ${head.sha}. The production-lag alarm is sighted. (OPE-1655)`];
    if (!env.ALERT_EMAIL_TECHNICAL || !env.EMAIL_JOBS) {
      await logError(env.DB, {
        level: "warn",
        source: DEPLOY_LAG_SOURCE,
        message: `[deploy-lag] would mail (${subject}) but ALERT_EMAIL_TECHNICAL/EMAIL_JOBS not configured`,
      });
    } else {
      try {
        await sendEmailJob(env.EMAIL_JOBS, env.DB, {
          to: env.ALERT_EMAIL_TECHNICAL,
          subject,
          text: `${body.join("\n\n")}\n\nSent by the Cloudflare deploy-lag watch (hourly, MCP Worker).\n`,
          html: `<p><strong>${subject}</strong></p>${body.map((l) => `<p>${l}</p>`).join("")}`,
          source: "deploy-lag-watch",
        });
        blindMailed = blindKind === "blind";
        blindSent = blindKind;
      } catch (error) {
        // Leave blindMailed unchanged so the mail is retried next hour.
        await logError(env.DB, {
          source: DEPLOY_LAG_SOURCE,
          message: "[deploy-lag] blind alert enqueue failed",
          error,
        });
      }
    }
  }

  const mainField = head.sha ? head.sha.slice(0, 7) : `?(${headFailureReason(head.note)})`;
  const stampNote =
    `state=${recorded};mcp=${workers[0].liveSha ?? "?"};app=${workers[1].liveSha ?? "?"};` +
    `main=${mainField};lag=${maxLag};blind=${blind}` +
    (blindMailed ? ";blindmail=1" : "");
  // Stamp LAST, so a crash above never reads as a healthy run (OPE-246 evidence).
  await db
    .insert(agentHeartbeats)
    .values({
      id: crypto.randomUUID(),
      agentCode: DEPLOY_LAG_WATCH_CODE,
      kind: "watchdog",
      lastSeenAt: now,
      note: stampNote,
    })
    .onConflictDoUpdate({
      target: agentHeartbeats.agentCode,
      set: { lastSeenAt: now, kind: "watchdog", note: stampNote },
    });

  console.log(`[cron] deploy-lag ${stampNote} (live state ${state}); mailed ${mailed ?? "none"}`);
  return {
    state,
    blindTicks: blind,
    blindMailed: blindSent,
    mainSha: head.sha,
    workers,
    pendingMigrations,
    mailed,
    stampNote,
  };
}
