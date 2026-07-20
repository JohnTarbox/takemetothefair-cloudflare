/**
 * OPE-225 — daily driver for the photo-coverage scan.
 *
 * Mirrors cpi-stale-red-canary exactly: POST the main-app internal endpoint
 * over `X-Internal-Key`, log the result, never throw. All the work (observe
 * every live entity, join 28-day GSC demand, reconcile `image_coverage_state`)
 * lives in the scan; this just fires it once a day from the daily cron branch.
 *
 * Why this file exists at all: the scan route shipped with no caller in PR 1,
 * which is the OPE-245 shape — "the ranker shipped in PR #317 but nothing ever
 * called it, so all 6,121 discrepancies were NULL-scored from ship." A rail
 * nobody invokes is indistinguishable from a rail that doesn't work.
 *
 * Failsoft by construction: a non-2xx or a thrown fetch is logged and
 * swallowed, so one bad run never trips Cloudflare's tighter cron-retry
 * schedule. The `image-coverage-scan` heartbeat probe (48h window) is the
 * backstop — if this canary silently stops firing, `max(checked_at)` goes
 * stale and the silence escalates through the OPE-75 digest.
 */
import type { Env } from "./index.js";
import { logError } from "./logger.js";

export async function runScheduledPhotoCoverageScan(env: Env): Promise<void> {
  const SOURCE = "mcp:schedule:photo-coverage";
  const sessionId = crypto.randomUUID();
  const url = `${env.MAIN_APP_URL ?? "https://meetmeatthefair.com"}/api/internal/photo-coverage/scan`;
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
        message: "photo-coverage scan returned non-2xx",
        statusCode: response.status,
        sessionId,
        context: { url, status: response.status, bodyExcerpt: body },
      });
      return;
    }
    const result = (await response.json().catch(() => ({}))) as {
      scanned?: number;
      newlyImaged?: number;
      imageless?: number;
      hotlinked?: number;
    };
    console.log(
      `[cron] photo-coverage scanned=${result.scanned ?? "?"} newlyImaged=${
        result.newlyImaged ?? "?"
      } imageless=${result.imageless ?? "?"} hotlinked=${result.hotlinked ?? "?"}`
    );
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "photo-coverage scan threw",
      error,
      sessionId,
    });
  }
}

/**
 * OPE-225 PR 2/2 — daily driver for the URL rot sweep.
 *
 * Separate from the coverage scan on purpose: the scan is pure D1 work and
 * finishes fast, while this one makes up to `ROT_SWEEP_LIMIT` outbound fetches
 * against third-party hosts. Keeping them apart means a slow or hostile image
 * host can never delay the coverage numbers, and either can fail without
 * taking the other down.
 *
 * Same failsoft contract: log and swallow, never throw into the cron.
 */
export async function runScheduledImageUrlHealthSweep(env: Env): Promise<void> {
  const SOURCE = "mcp:schedule:image-url-health";
  const sessionId = crypto.randomUUID();
  const url = `${env.MAIN_APP_URL ?? "https://meetmeatthefair.com"}/api/internal/photo-coverage/url-health`;
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
        message: "image URL health sweep returned non-2xx",
        statusCode: response.status,
        sessionId,
        context: { url, status: response.status, bodyExcerpt: body },
      });
      return;
    }
    const result = (await response.json().catch(() => ({}))) as {
      checked?: number;
      unreachable?: number;
      recovered?: number;
    };
    console.log(
      `[cron] image-url-health checked=${result.checked ?? "?"} unreachable=${
        result.unreachable ?? "?"
      } recovered=${result.recovered ?? "?"}`
    );
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "image URL health sweep threw",
      error,
      sessionId,
    });
  }
}
