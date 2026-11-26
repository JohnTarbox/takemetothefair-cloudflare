/**
 * OPE-1597 — daily full-table duplicate sweep.
 *
 * POSTs the main app's /api/admin/duplicates/full-sweep once per entity type, so
 * each type has its own memory and CPU budget. The main app owns the comparison
 * and the write, and writes proposals only. The heartbeat probe
 * `entity-duplicate-full-sweep` reads the oldest run row across all four types.
 *
 * Failsoft like the sibling sweeps: one type failing is logged and the next
 * still runs.
 */
import { mainAppBindingRequest } from "./main-app-fetch.js";
import type { Env } from "./index.js";
import { logError } from "./logger.js";

const SOURCE = "mcp:schedule:full-duplicate-sweep";
const TYPES = ["venues", "events", "vendors", "promoters"] as const;

/**
 * OPE-1690 — backoff before re-POSTing a type whose sweep failed. A D1 overload
 * is a 10-second window; the endpoint publishes nothing on a short write, so a
 * retry starts a clean run. 20 s then 60 s clears the window twice over.
 */
export const SWEEP_RETRY_DELAYS_MS = [20_000, 60_000];

/** Bodies that say the failure was D1 load, the one failure worth retrying. */
function isOverloadBody(body: string): boolean {
  return /overloaded|too many resources|queued for too long/i.test(body);
}

export async function runScheduledFullDuplicateSweep(
  env: Env,
  opts: { sleep?: (ms: number) => Promise<void> } = {}
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const url = `${env.MAIN_APP_URL ?? "https://meetmeatthefair.com"}/api/admin/duplicates/full-sweep`;
  for (const type of TYPES) {
    for (let attempt = 0; ; attempt++) {
      let failure: { message: string; statusCode?: number; body?: string; error?: unknown };
      try {
        const init: RequestInit = {
          method: "POST",
          headers: {
            "X-Internal-Key": env.INTERNAL_API_KEY ?? "",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ type }),
        };
        const res = env.MAIN_APP
          ? await env.MAIN_APP.fetch(mainAppBindingRequest(url, init))
          : await fetch(url, init);
        if (res.ok) break;
        failure = {
          message: "full-sweep endpoint returned non-2xx",
          statusCode: res.status,
          body: (await res.text()).slice(0, 300),
        };
      } catch (err) {
        failure = { message: "full-sweep call threw", error: err, body: String(err) };
      }

      // Retry only what load explains; a 401 or a code bug fails the same way twice.
      const retryable = isOverloadBody(failure.body ?? "") || (failure.statusCode ?? 0) >= 503;
      if (retryable && attempt < SWEEP_RETRY_DELAYS_MS.length) {
        console.warn(
          `[cron] full-duplicate-sweep ${type}: ${failure.message}; retry ${attempt + 1} in ${SWEEP_RETRY_DELAYS_MS[attempt]}ms`
        );
        await sleep(SWEEP_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      await logError(env.DB, {
        source: SOURCE,
        message: failure.message,
        statusCode: failure.statusCode,
        error: failure.error,
        context: { url, type, attempts: attempt + 1, bodyExcerpt: failure.body },
      }).catch(() => {});
      break;
    }
  }
}
