/**
 * Issue #326 — Slack canary for page-level fetcher errors.
 *
 * What it watches
 * ---------------
 * Every page-level data fetcher in the app follows the same shape:
 *
 *     try {
 *       // ... db.select() ... return data;
 *     } catch (e) {
 *       await logError(db, { source: "app/<route>/page.tsx:<fn>", ... });
 *       return <empty default>;   // ← renders as empty state on the page
 *     }
 *
 * That default-on-error pattern means user-facing pages render byte-for-byte
 * like a real zero-match — silent failure. The 2026-06-04 D1 100-col outage
 * (PR #325 + #327) hit this pattern across `events`, `venues`, `promoters`,
 * `vendor` surfaces and burned ~16 hours before a user noticed.
 *
 * This canary polls `error_logs` every 10 minutes (piggy-backing the existing
 * `*\/10 * * * *` cron alongside the KPI recompute + inbound-email stale sweep),
 * counts entries since the last fire whose `source` matches
 * `app/%page.tsx:%`, and dispatches Slack + email alerts on:
 *
 *   - RED    — >= RED_THRESHOLD errors in 10 min, PER SOURCE
 *   - YELLOW — >= YELLOW_THRESHOLD errors in 10 min, PER SOURCE
 *
 * ⚠️ The live values are the constants below (RED 10 / YELLOW 3), not the
 * 50/10 this block claimed until 2026-08-27. The numbers were changed when the
 * canary moved to per-source counting and the prose was not — which matters,
 * because OPE-574 reasoned from the stale figures to conclude this canary had
 * missed a fault it had in fact caught. Read the constants, not this comment.
 *
 * Debounced via `page_error_canary_state` (one row per tier) so a single
 * sustained outage doesn't fire the same tier every cron tick:
 *
 *   - RED   debounce 30 min
 *   - YELLOW debounce 60 min
 *
 * RED bypasses the YELLOW debounce (a real outage shouldn't be muted because
 * a sub-threshold blip 40 min ago already fired YELLOW).
 *
 * OPE-1582 (2026-11-08) — at most ONE alert per fire. When two or more sources
 * fire together they go out as a single burst alert listing every source, and
 * while that alert is open no further per-function alerts are sent. Every
 * source still gets its own debounce row. See `planAlerts`.
 *
 * Dispatch channels
 * -----------------
 * Same fan-out as the dedup-sweep canary (PR #306):
 *   - SLACK_WEBHOOK_URL_TECHNICAL — POSTs to a Slack incoming-webhook.
 *   - ALERT_EMAIL_TECHNICAL        — pushes an email-job message to
 *                                    env.EMAIL_JOBS; the queue consumer
 *                                    (this same Worker) sends via
 *                                    Cloudflare Email Sending.
 * Both are independent optional secrets. With neither set, the canary still
 * runs (computes tier, updates debounce row) but never pushes — purely
 * log-only via the persisted state.
 *
 * Per the MCP server's cron-handler convention: errors are logged via
 * logError() and swallowed — never thrown — so a single canary failure
 * doesn't trigger Cloudflare's cron retry.
 */
import { and, count, eq, gte, inArray, like, lt } from "drizzle-orm";
import { pageErrorCanaryState } from "@takemetothefair/db-schema";
import { errorLogs } from "./schema.js";
import type { Env } from "./index.js";
import type { Db } from "./db.js";
import { getDb } from "./db.js";
import { logError } from "./logger.js";
import { getErrorLogsBurstWindow } from "./error-logs-burst.js";

const SLACK_BUDGET_MS = 5_000;

/** OPE-252 — auto-decay: a canary-state row this stale whose source has had
 *  zero matching errors in the window is a fixed-but-never-cleared alert (the
 *  41-day-old getEvent/getVendor YELLOWs). Cleared automatically so no human
 *  hand-DELETE is needed. */
const CANARY_STATE_DECAY_DAYS = 14;

/**
 * OPE-252 — transient-D1 patterns. The 2026-07-13 outage failed the canary's
 * own aggregate query with "D1_ERROR: Network connection lost" — a shared-fate
 * blip that resolves on a retry. (The main app's withD1Retry — never called,
 * deleted in OPE-909 — did not include this string either.)
 */
const TRANSIENT_D1_PATTERNS = ["network connection lost", "internal error", "connection reset"];

function isTransientD1Error(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return TRANSIENT_D1_PATTERNS.some((p) => msg.includes(p));
}

/**
 * OPE-252 — run `op`; on a TRANSIENT D1 error, log the first failure at `warn`
 * and retry once after a short backoff. A non-transient error, or a second
 * failure, propagates to the caller (which logs it at `error`). This stops a
 * one-off scheduler blip from landing an `error` row indistinguishable from an
 * app fault — and stops the canary going blind on the exact D1 wobble it exists
 * to watch.
 */
async function retryOnceOnTransientD1<T>(
  db: Db,
  source: string,
  label: string,
  op: () => Promise<T>
): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (!isTransientD1Error(err)) throw err;
    await logError(db, {
      level: "warn",
      source,
      message: `${label} hit a transient D1 error; retrying once`,
      error: err,
    });
    await new Promise((r) => setTimeout(r, 250));
    return await op(); // a second failure propagates → caller logs error
  }
}

/**
 * OPE-252 — clear canary-state rows older than the decay window whose source
 * has had zero matching `error_logs` in that window (the underlying fault is
 * gone). Logs one `info` receipt per decayed row. Failsoft: never throws — a
 * decay hiccup must not block the canary's actual alerting job.
 */
async function decayStaleCanaryState(db: Db, source: string, now: Date): Promise<void> {
  try {
    const cutoff = new Date(now.getTime() - CANARY_STATE_DECAY_DAYS * 24 * 60 * 60_000);
    const stale = await db
      .select({ tier: pageErrorCanaryState.tier, source: pageErrorCanaryState.source })
      .from(pageErrorCanaryState)
      .where(lt(pageErrorCanaryState.lastAlertedAt, cutoff));
    for (const row of stale) {
      // Only decay when the fault is genuinely gone: zero matching error_logs
      // for this source in the decay window. A row that's stale but still
      // erroring stays put (the debounce logic re-alerts it).
      const [recent] = await db
        .select({ n: count() })
        .from(errorLogs)
        .where(and(eq(errorLogs.source, row.source), gte(errorLogs.timestamp, cutoff)));
      if (Number(recent?.n ?? 0) > 0) continue;
      await db
        .delete(pageErrorCanaryState)
        .where(
          and(eq(pageErrorCanaryState.tier, row.tier), eq(pageErrorCanaryState.source, row.source))
        );
      await logError(db, {
        level: "info",
        source,
        message: `canary-state decayed: ${row.tier} ${row.source} — no matching errors in ${CANARY_STATE_DECAY_DAYS}d`,
      });
    }
  } catch (err) {
    await logError(db, {
      level: "warn",
      source,
      message: "canary-state decay failed (non-fatal; alerting unaffected)",
      error: err,
    });
  }
}

/** The cron fires every 10 minutes; the window matches so each fire looks
 *  at the errors logged since the previous fire (no double-counting). */
const WINDOW_MINUTES = 10;

/** Source filter — every page-level fetcher writes logError with a source
 *  of `app/<path>/page.tsx:<funcName>`. SQL `LIKE 'app/%page.tsx:%'`
 *  catches all of them and is stable against new pages being added.
 *  Caveat: also catches admin pages (operator wants to know about admin
 *  breaks too — confirmed via the 2026-06-04 outage that briefly hit
 *  `app/admin/page.tsx:getRecentSubmissions`). */
const SOURCE_PATTERN = "app/%page.tsx:%";

/** Per-SOURCE tier thresholds (B2 per-source refactor, 2026-06-05).
 *  The 2026-06-04 outage drove ~42 errs/win aggregate but ~10/win per
 *  affected source (4 fetchers split the volume). Per-source thresholds:
 *  RED=10/win and YELLOW=3/win catch the same outage shape source-by-
 *  source. Lower numbers than the aggregate thresholds because a
 *  single fetcher spiking is a strong signal — global outages produce
 *  multiple separate per-source alerts which is the desired UX (you
 *  see WHICH fetchers broke). */
const RED_THRESHOLD = 10;
const YELLOW_THRESHOLD = 3;

/** Debounce — page-error state can flip on a single deploy, so these
 *  are in deploy-turnaround-time order of magnitude (not the dedup
 *  canary's 72h which matches that slow-moving signal). */
const RED_DEBOUNCE_MINUTES = 30;
const YELLOW_DEBOUNCE_MINUTES = 60;

type Tier = "RED" | "YELLOW";

/** Pure decision function — exported for unit tests. Returns the alert tier
 *  to fire, or null when below YELLOW. RED takes precedence regardless of
 *  YELLOW debounce; YELLOW respects its own debounce. */
export function decideTier(
  count: number,
  redLastAlertedAt: Date | null,
  yellowLastAlertedAt: Date | null,
  now: Date
): Tier | null {
  if (count >= RED_THRESHOLD) {
    const redCutoff = new Date(now.getTime() - RED_DEBOUNCE_MINUTES * 60_000);
    if (redLastAlertedAt == null || redLastAlertedAt < redCutoff) return "RED";
    return null;
  }
  if (count >= YELLOW_THRESHOLD) {
    const yellowCutoff = new Date(now.getTime() - YELLOW_DEBOUNCE_MINUTES * 60_000);
    if (yellowLastAlertedAt == null || yellowLastAlertedAt < yellowCutoff) return "YELLOW";
    return null;
  }
  return null;
}

/** OPE-1582 — how many sources must fire in one tick for it to be one burst. */
const BURST_MIN_SOURCES = 2;

/** OPE-1582 — the `page_error_canary_state.source` value for the burst-level
 *  alert. Not a real source, and it can't collide with one: every real source
 *  matches SOURCE_PATTERN. Lives in the existing (tier, source) table so a
 *  burst debounces with the same 30/60-min windows, with no migration. */
const BURST_STATE_SOURCE = "__burst__";

/** Max sources read per tick. This was 5, which silently capped a burst at
 *  five alerts: the 2026-11-08 09:36Z D1 burst hit 7 loaders and two of them
 *  never alerted. Stays well under D1's 100-bound-parameter limit, because
 *  these names feed the state read's `inArray`. */
const TOP_SOURCES_LIMIT = 25;

export interface FiredSource {
  source: string;
  count: number;
  tier: Tier;
}

export type AlertPlan =
  | { kind: "none"; debounced: number }
  | { kind: "suppressed-by-open-burst"; fired: FiredSource[]; debounced: number }
  | { kind: "single"; fired: FiredSource; debounced: number }
  | { kind: "burst"; tier: Tier; fired: FiredSource[]; debounced: number };

/** OPE-1582 — true when an already-sent burst alert covers an alert of `tier`.
 *  A RED burst covers both tiers for its 30 min. A YELLOW burst covers YELLOW
 *  for its 60 min but NOT RED, so an escalation still reaches a human (the
 *  same "RED bypasses YELLOW" rule as decideTier). */
export function isBurstOpen(
  tier: Tier,
  burstRedLastAt: Date | null,
  burstYellowLastAt: Date | null,
  now: Date
): boolean {
  const redCutoff = new Date(now.getTime() - RED_DEBOUNCE_MINUTES * 60_000);
  if (burstRedLastAt != null && burstRedLastAt >= redCutoff) return true;
  if (tier === "RED") return false;
  const yellowCutoff = new Date(now.getTime() - YELLOW_DEBOUNCE_MINUTES * 60_000);
  return burstYellowLastAt != null && burstYellowLastAt >= yellowCutoff;
}

/** OPE-1582 — pure: per-source tiers in, at most ONE alert out.
 *  `lastAlerted` is keyed `${tier}::${source}`. */
export function planAlerts(
  candidates: Array<{ source: string; count: number }>,
  lastAlerted: Map<string, Date>,
  now: Date
): AlertPlan {
  const fired: FiredSource[] = [];
  let debounced = 0;
  for (const c of candidates) {
    const tier = decideTier(
      c.count,
      lastAlerted.get(`RED::${c.source}`) ?? null,
      lastAlerted.get(`YELLOW::${c.source}`) ?? null,
      now
    );
    if (tier == null) debounced++;
    else fired.push({ source: c.source, count: c.count, tier });
  }
  if (fired.length === 0) return { kind: "none", debounced };

  const tier: Tier = fired.some((f) => f.tier === "RED") ? "RED" : "YELLOW";
  const burstOpen = isBurstOpen(
    tier,
    lastAlerted.get(`RED::${BURST_STATE_SOURCE}`) ?? null,
    lastAlerted.get(`YELLOW::${BURST_STATE_SOURCE}`) ?? null,
    now
  );
  if (burstOpen) return { kind: "suppressed-by-open-burst", fired, debounced };
  if (fired.length >= BURST_MIN_SOURCES) return { kind: "burst", tier, fired, debounced };
  return { kind: "single", fired: fired[0], debounced };
}

/** OPE-1582 — the burst alert's wording. `isD1` is measured from the window's
 *  rows, so a burst from a bad deploy is never labelled a D1 problem. */
export function renderBurstAlert(
  tier: Tier,
  fired: FiredSource[],
  isD1: boolean,
  totalCount: number
): { subject: string; slackText: string; textBody: string; htmlBody: string } {
  const emoji = tier === "RED" ? "🔴" : "🟡";
  const label = isD1 ? "D1 burst" : "Page-error burst";
  const sum = fired.reduce((n, f) => n + f.count, 0);
  const headline = `${sum} errors across ${fired.length} loaders`;
  const logsUrl = "https://meetmeatthefair.com/admin/logs";
  const others = totalCount - sum;
  const othersLine = others > 0 ? `\n+${others} more on sources below the alert threshold.` : "";
  const lines = fired.map((f) => `  ${f.count}  ${f.source} (${f.tier})`).join("\n");
  return {
    subject: `${emoji} ${label}: ${headline} (${WINDOW_MINUTES}m)`,
    slackText:
      `${emoji} *${label}* — ${headline} in last ${WINDOW_MINUTES} min\n` +
      "```\n" +
      lines +
      "\n```" +
      othersLine +
      `\n<${logsUrl}|Open admin/logs>`,
    textBody:
      `${headline} in the last ${WINDOW_MINUTES} minutes.\n\n${lines}\n${othersLine}\n\n` +
      `No further alerts for these until this one ages out (RED ${RED_DEBOUNCE_MINUTES} min, ` +
      `YELLOW ${YELLOW_DEBOUNCE_MINUTES} min).\n\nOpen admin/logs: ${logsUrl}\n`,
    htmlBody:
      `<p><strong>${emoji} ${label}</strong> — ${headline} in last ${WINDOW_MINUTES} min</p>` +
      `<ul>${fired
        .map((f) => `<li>${f.count} — <code>${f.source}</code> (${f.tier})</li>`)
        .join("")}</ul>` +
      (others > 0 ? `<p>+${others} more on sources below the alert threshold.</p>` : "") +
      `<p><a href="${logsUrl}">Open admin/logs</a></p>`,
  };
}

/** POST a Slack message via the incoming-webhook URL. No-op if url is
 *  empty/undefined. Mirrors dedup-sweep-canary.postSlackWebhook exactly
 *  rather than refactoring to a shared helper (the two canaries are the
 *  only callers; if a third appears, extract then). */
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
 * Main entry point. Exported for both index.ts and unit tests.
 *
 * Idempotent: re-running within a single window will just re-evaluate
 * against the same error_logs rows. The debounce state prevents
 * re-dispatching for the same outage.
 */
export async function runScheduledPageErrorCanary(env: Env): Promise<void> {
  const SOURCE = "mcp:schedule:page-error-canary";
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_MINUTES * 60_000);
  const db = getDb(env.DB);

  // OPE-252 — self-hygiene: clear fixed-but-never-cleared canary rows first
  // (failsoft; never blocks the alerting below).
  await decayStaleCanaryState(db, SOURCE, now);

  // 1. Count + per-source breakdown over the window.
  // B2 (2026-06-04, REL1' §0) — refactored to call the shared
  // `getErrorLogsBurstWindow` helper (B1). The helper returns the full
  // top-N source breakdown so the alert body can show *which* fetchers
  // spiked, not just the loudest one. Per-source DEBOUNCE (one alert per
  // source) is deferred: `page_error_canary_state` is keyed by tier only,
  // so per-source debounce needs a schema change. Until then the alert
  // body lists the top sources so a noisy-but-broad outage and a
  // narrow-but-deep one are visually distinguishable.
  let totalCount: number;
  let bySource: Array<{ source: string | null; count: number }>;
  try {
    // OPE-252 — retry once on a transient D1 blip (the 2026-07-13 "Network
    // connection lost" that blinded this canary during the exact window it
    // watches). First transient failure logs `warn` inside the helper; a
    // second failure falls through to the `error` log below.
    const burst = await retryOnceOnTransientD1(db, SOURCE, "error_logs aggregate query", () =>
      getErrorLogsBurstWindow(db, {
        since: windowStart,
        until: now,
        sourcePattern: SOURCE_PATTERN,
        // Minimum to track via this helper is YELLOW threshold; we rely on
        // the existing decideTier() to actually decide what fires.
        minCount: YELLOW_THRESHOLD,
        topSourcesLimit: TOP_SOURCES_LIMIT,
      })
    );
    totalCount = burst.totalErrors;
    bySource = burst.bySource;
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "error_logs aggregate query failed",
      error,
      sessionId,
    });
    return;
  }

  // ── 2. Per-source debounce evaluation (B2 follow-up, 2026-06-05) ──
  //
  // Was: one decideTier() on totalCount with two debounce rows (RED +
  // YELLOW). A multi-source outage debounced as one event.
  //
  // Now: load all (tier, source) debounce rows for the sources in
  // this window, then decide+dispatch per-source. Each source gets
  // its own debounce window — a localized regression on getEvents
  // and a separate one on getVenue alert independently.
  //
  // Cheap-path early-exit: if no source crosses YELLOW_THRESHOLD at
  // all (sub-3 per source), skip the debounce-state read entirely.
  const candidateSources = bySource.filter((s) => s.source && s.count >= YELLOW_THRESHOLD);
  if (candidateSources.length === 0) {
    console.log(
      `[cron] page-error-canary ok — total=${totalCount}, ` +
        `no source crossed YELLOW threshold (${YELLOW_THRESHOLD}/win) — no alert`
    );
    return;
  }

  // Load only the debounce rows for our candidate sources (avoids a
  // table-scan when most sources are silent).
  const candidateSourceNames = candidateSources.map((s) => s.source!);
  const debounceByKey = new Map<string, Date>(); // key = `${tier}::${source}`
  try {
    const stateRows = await db
      .select()
      .from(pageErrorCanaryState)
      .where(inArray(pageErrorCanaryState.source, [...candidateSourceNames, BURST_STATE_SOURCE]));
    for (const row of stateRows) {
      debounceByKey.set(`${row.tier}::${row.source}`, row.lastAlertedAt);
    }
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "page_error_canary_state read failed",
      error,
      sessionId,
    });
    return;
  }

  const webhookUrl = env.SLACK_WEBHOOK_URL_TECHNICAL;
  const alertEmail = env.ALERT_EMAIL_TECHNICAL;

  // Exactly one Slack post + one email per fire (OPE-1582), whatever `plan` is.
  async function dispatch(
    tier: Tier,
    label: string,
    context: Record<string, unknown>,
    alert: { slackText: string; subject: string; textBody: string; htmlBody: string }
  ): Promise<void> {
    if (webhookUrl) {
      const result = await postSlackWebhook(webhookUrl, alert.slackText);
      if (!result.ok) {
        await logError(env.DB, {
          source: SOURCE,
          message: `${tier} Slack dispatch failed for ${label}: ${result.error}`,
          sessionId,
          context,
        });
      } else {
        console.log(`[cron] page-error-canary ${tier} → Slack — ${label}`);
      }
    }

    if (alertEmail && env.EMAIL_JOBS) {
      try {
        await env.EMAIL_JOBS.send({
          to: alertEmail,
          subject: alert.subject,
          text: alert.textBody,
          html: alert.htmlBody,
          source: `page-error-canary:${tier.toLowerCase()}`,
        });
      } catch (error) {
        await logError(env.DB, {
          source: SOURCE,
          message: `${tier} email enqueue failed for ${label}`,
          error,
          sessionId,
          context: { ...context, alertEmail },
        });
      }
    } else if (alertEmail && !env.EMAIL_JOBS) {
      await logError(env.DB, {
        level: "warn",
        source: SOURCE,
        message: "ALERT_EMAIL_TECHNICAL is set but EMAIL_JOBS queue binding is missing",
        sessionId,
      });
    }
  }

  // Upsert one (tier, source) debounce row.
  async function stamp(tier: Tier, src: string, lastCount: number): Promise<void> {
    try {
      await db
        .insert(pageErrorCanaryState)
        .values({ tier, source: src, lastAlertedAt: now, lastCount })
        .onConflictDoUpdate({
          target: [pageErrorCanaryState.tier, pageErrorCanaryState.source],
          set: { lastAlertedAt: now, lastCount },
        });
    } catch (error) {
      await logError(env.DB, {
        source: SOURCE,
        message: `${tier} debounce row upsert failed for ${src}`,
        error,
        sessionId,
        context: { tier, src, count: lastCount },
      });
    }
  }

  const plan = planAlerts(
    candidateSources.map((c) => ({ source: c.source!, count: c.count })),
    debounceByKey,
    now
  );

  if (plan.kind === "none") {
    console.log(
      `[cron] page-error-canary all-debounced — ${plan.debounced} sources crossed ` +
        `but every (tier, source) within debounce window; no alert fired`
    );
    return;
  }

  if (plan.kind === "suppressed-by-open-burst") {
    // Deliberately NOT stamped: if a source is still failing once the burst
    // alert ages out, it must be able to alert again.
    console.log(
      `[cron] page-error-canary suppressed by open burst alert — ` +
        plan.fired.map((f) => `${f.source}=${f.count}`).join(", ")
    );
    return;
  }

  if (plan.kind === "single") {
    const { source: src, count: n, tier } = plan.fired;
    const emoji = tier === "RED" ? "🔴" : "🟡";
    await dispatch(
      tier,
      `src=${src} count=${n}`,
      { tier, src, count: n },
      {
        slackText:
          `${emoji} *Page-error canary ${tier}* — \`${src}\` got ${n} errors in last ${WINDOW_MINUTES} min` +
          `\n<https://meetmeatthefair.com/admin/logs|Open admin/logs>`,
        subject: `${emoji} Page-error canary ${tier}: ${src} (${n} in ${WINDOW_MINUTES}m)`,
        textBody:
          `${n} errors on \`${src}\` in the last ${WINDOW_MINUTES} minutes.\n\n` +
          `Open admin/logs: https://meetmeatthefair.com/admin/logs\n`,
        htmlBody:
          `<p><strong>${emoji} Page-error canary ${tier}</strong> — ${n} errors on <code>${src}</code> in last ${WINDOW_MINUTES} min</p>` +
          `<p><a href="https://meetmeatthefair.com/admin/logs">Open admin/logs</a></p>`,
      }
    );
    await stamp(tier, src, n);
    console.log(
      `[cron] page-error-canary fired=1 debounced=${plan.debounced} ` +
        `(window=${WINDOW_MINUTES}m, total=${totalCount})`
    );
    return;
  }

  // plan.kind === "burst"
  const isD1 = await windowIsMostlyD1(db, windowStart, now, totalCount, SOURCE, env, sessionId);
  await dispatch(
    plan.tier,
    `burst of ${plan.fired.length} sources`,
    { tier: plan.tier, sources: plan.fired.length, isD1 },
    renderBurstAlert(plan.tier, plan.fired, isD1, totalCount)
  );
  // Every source is still stamped, so per-source debounce keeps its meaning
  // and the state table records each one that alerted.
  for (const f of plan.fired) await stamp(f.tier, f.source, f.count);
  await stamp(
    plan.tier,
    BURST_STATE_SOURCE,
    plan.fired.reduce((n, f) => n + f.count, 0)
  );
  console.log(
    `[cron] page-error-canary burst fired sources=${plan.fired.length} ` +
      `debounced=${plan.debounced} isD1=${isD1} (window=${WINDOW_MINUTES}m, total=${totalCount})`
  );
}

/** OPE-1582 — does this window's page-error set look like D1 saturation?
 *  Measured, so the alert's "D1" label is a finding. Failsoft: a failed read
 *  only costs the label. Only runs when a burst is about to be sent. */
async function windowIsMostlyD1(
  db: Db,
  since: Date,
  until: Date,
  totalCount: number,
  source: string,
  env: Env,
  sessionId: string
): Promise<boolean> {
  try {
    const [row] = await db
      .select({ n: count() })
      .from(errorLogs)
      .where(
        and(
          gte(errorLogs.timestamp, since),
          lt(errorLogs.timestamp, until),
          eq(errorLogs.level, "error"),
          like(errorLogs.source, SOURCE_PATTERN),
          like(errorLogs.message, "%D1_ERROR%")
        )
      );
    return totalCount > 0 && Number(row?.n ?? 0) * 2 >= totalCount;
  } catch (error) {
    await logError(env.DB, {
      level: "warn",
      source,
      message: "burst D1-share read failed (alert still sends, without the D1 label)",
      error,
      sessionId,
    });
    return false;
  }
}

// Exported for unit tests.
export const __test = {
  decideTier,
  isBurstOpen,
  planAlerts,
  renderBurstAlert,
  BURST_STATE_SOURCE,
  BURST_MIN_SOURCES,
  postSlackWebhook,
  RED_THRESHOLD,
  YELLOW_THRESHOLD,
  RED_DEBOUNCE_MINUTES,
  YELLOW_DEBOUNCE_MINUTES,
  WINDOW_MINUTES,
  SOURCE_PATTERN,
  // OPE-252
  isTransientD1Error,
  retryOnceOnTransientD1,
  decayStaleCanaryState,
  CANARY_STATE_DECAY_DAYS,
};
