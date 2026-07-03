/**
 * OPE-75 — CPI Move 1: daily canary for stale dashboard reds.
 *
 * Mirrors the dedup-sweep-canary / runMainAppSweep pattern: POST the main-app
 * internal scan endpoint over `X-Internal-Key`, log the result, never throw.
 * The scan does all the work (rebuild the action queue, pick stale reds, and —
 * best-effort — enqueue ONE operator digest); this canary just fires it once
 * per day from the daily cron branch. All escalation cadence lives in the
 * scan; there is no per-signal state here.
 *
 * Failsoft by construction: a non-2xx or a thrown fetch is logged via
 * logError() and swallowed, so a single canary failure never triggers
 * Cloudflare's tighter-schedule cron retry.
 */
import type { Env } from "./index.js";
import { logError } from "./logger.js";

export async function runScheduledCpiStaleRedCanary(env: Env): Promise<void> {
  const SOURCE = "mcp:schedule:cpi-stale-red";
  const sessionId = crypto.randomUUID();
  const url = `${env.MAIN_APP_URL ?? "https://meetmeatthefair.com"}/api/internal/cpi/stale-red-scan`;
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Key": env.INTERNAL_API_KEY ?? "",
    },
  };

  try {
    const response = env.MAIN_APP
      ? await env.MAIN_APP.fetch(new Request(url, init))
      : await fetch(url, init);
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      await logError(env.DB, {
        source: SOURCE,
        message: "cpi stale-red scan returned non-2xx",
        statusCode: response.status,
        sessionId,
        context: { url, status: response.status, bodyExcerpt: body },
      });
      return;
    }
    const result = (await response.json().catch(() => ({}))) as {
      count?: number;
      sent?: boolean;
    };
    console.log(
      `[cron] cpi-stale-red fired count=${result.count ?? "?"} sent=${result.sent ?? "?"}`
    );
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "cpi stale-red scan threw",
      error,
      sessionId,
    });
  }
}
