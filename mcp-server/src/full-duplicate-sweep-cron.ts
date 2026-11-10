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

export async function runScheduledFullDuplicateSweep(env: Env): Promise<void> {
  const url = `${env.MAIN_APP_URL ?? "https://meetmeatthefair.com"}/api/admin/duplicates/full-sweep`;
  for (const type of TYPES) {
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
      if (!res.ok) {
        await logError(env.DB, {
          source: SOURCE,
          message: "full-sweep endpoint returned non-2xx",
          statusCode: res.status,
          context: { url, type, bodyExcerpt: (await res.text()).slice(0, 300) },
        });
      }
    } catch (err) {
      await logError(env.DB, {
        source: SOURCE,
        message: "full-sweep call threw",
        error: err,
        context: { url, type },
      }).catch(() => {});
    }
  }
}
