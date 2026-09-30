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
import { mainAppBindingRequest } from "./main-app-fetch.js";
import { withMainAppSlot, isWorkerOom } from "./main-app-gate.js";
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
    // OPE-489 — same main-app slot gate as runMainAppSweep. This canary is a
    // sibling in the daily Promise.all, so without the gate it contributed to
    // (and died from) the shared-isolate OOM alongside the other sweeps.
    const response = await withMainAppSlot(() =>
      env.MAIN_APP ? env.MAIN_APP.fetch(mainAppBindingRequest(url, init)) : fetch(url, init)
    );
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      // OPE-489 §4 — name an isolate OOM kill distinctly from a transient 5xx.
      const oom = isWorkerOom(body);
      await logError(env.DB, {
        source: SOURCE,
        message: oom
          ? "photo-coverage scan killed by Worker memory limit"
          : "photo-coverage scan returned non-2xx",
        statusCode: response.status,
        sessionId,
        context: {
          url,
          status: response.status,
          bodyExcerpt: body,
          cause: oom ? "worker-oom" : "non-2xx",
        },
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
      ? await env.MAIN_APP.fetch(mainAppBindingRequest(url, init))
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

/**
 * OPE-227 increment C — daily driver for the photo flywheel's hero PROPOSALS.
 *
 * Runs after the coverage scan (it reads the scan's demand ranking). Stages up
 * to 10 organizer og:image proposals for the most-seen imageless event pages;
 * writes NO `image_url` — a human approves each one via resolve_hero_proposal
 * (John's ruling 2026-09-01/02: hold everything, auto-apply nothing).
 *
 * Same failsoft contract as its siblings. The `photo-flywheel-hero-proposals`
 * heartbeat probe is the backstop: every run leaves one `admin_actions` row per
 * candidate (a proposal or an attempt), and the candidate pool (664 on
 * 2026-09-16) is larger than the 30-day hold-out can ever remove (10/day ×
 * 30 = 300), so a healthy run always leaves evidence.
 */
export async function runScheduledHeroProposals(env: Env): Promise<void> {
  const SOURCE = "mcp:schedule:hero-proposals";
  const sessionId = crypto.randomUUID();
  const url = `${env.MAIN_APP_URL ?? "https://meetmeatthefair.com"}/api/admin/photo-flywheel/hero-proposals?limit=10`;
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Key": env.INTERNAL_API_KEY ?? "",
    },
  };

  try {
    const response = await withMainAppSlot(() =>
      env.MAIN_APP ? env.MAIN_APP.fetch(mainAppBindingRequest(url, init)) : fetch(url, init)
    );
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      await logError(env.DB, {
        source: SOURCE,
        message: "hero proposals run returned non-2xx",
        statusCode: response.status,
        sessionId,
        context: { url, status: response.status, bodyExcerpt: body },
      });
      return;
    }
    const result = (await response.json().catch(() => ({}))) as {
      selected?: number;
      proposed?: number;
      by_outcome?: Record<string, number>;
    };
    console.log(
      `[cron] hero-proposals selected=${result.selected ?? "?"} proposed=${result.proposed ?? "?"} outcomes=${JSON.stringify(result.by_outcome ?? {})}`
    );
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "hero proposals run threw",
      error,
      sessionId,
    });
  }
}
