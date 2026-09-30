/**
 * OPE-1201 — daily near-duplicate candidate sweep.
 *
 * POSTs the main app's /api/admin/duplicates/near-sweep with `dry_run: false`.
 * The main app owns the predicate and the write (report-only: it sets
 * `events.possible_duplicate_of` where NULL, nothing else) and records one
 * `admin_actions` run row per call — the heartbeat probe
 * `near-duplicate-sweep` reads that row, so a cron that stops firing is caught.
 *
 * Failsoft like the sibling canaries: logs and swallows, never throws, so one
 * failed call cannot take the rest of the daily batch down with it.
 */
import { mainAppBindingRequest } from "./main-app-fetch.js";
import type { Env } from "./index.js";
import { logError } from "./logger.js";

const SOURCE = "mcp:schedule:near-duplicate-sweep";

export async function runScheduledNearDuplicateSweep(env: Env): Promise<void> {
  const url = `${env.MAIN_APP_URL ?? "https://meetmeatthefair.com"}/api/admin/duplicates/near-sweep`;
  try {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "X-Internal-Key": env.INTERNAL_API_KEY ?? "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ dry_run: false }),
    };
    const res = env.MAIN_APP
      ? await env.MAIN_APP.fetch(mainAppBindingRequest(url, init))
      : await fetch(url, init);
    if (!res.ok) {
      await logError(env.DB, {
        source: SOURCE,
        message: "near-sweep endpoint returned non-2xx",
        statusCode: res.status,
        context: { url, bodyExcerpt: (await res.text()).slice(0, 300) },
      });
    }
  } catch (err) {
    await logError(env.DB, {
      source: SOURCE,
      message: "near-sweep call threw",
      error: err,
      context: { url },
    }).catch(() => {});
  }
}
