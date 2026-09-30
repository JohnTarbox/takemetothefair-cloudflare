/**
 * OPE-951 — daily trigger for the main app's burst-cap self-test.
 *
 * The main app does the work (`POST /api/internal/burst-selftest`): it drives
 * the production burst cap to a refusal through the same `getBurstLimiter()`
 * that guards the eight abuse-prone routes, and stamps a heartbeat only on a
 * pass. This canary only fires it and logs a non-2xx, so a failing self-test
 * is visible in `error_logs` on BOTH Workers, and the missing stamp escalates
 * through the `burst-cap-selftest` heartbeat probe.
 *
 * Failsoft: never throws, so one failure cannot trigger a cron retry storm.
 */
import type { Env } from "./index.js";
import { logError } from "./logger.js";
import { mainAppFetch } from "./main-app-fetch.js";

export async function runScheduledBurstCapSelfTest(env: Env): Promise<void> {
  const SOURCE = "mcp:schedule:burst-cap-selftest";
  try {
    const res = await mainAppFetch(env, "/api/internal/burst-selftest", "scheduled", {
      method: "POST",
    });
    const body = (await res.text()).slice(0, 500);
    if (!res.ok) {
      await logError(env.DB, {
        source: SOURCE,
        message: "burst cap self-test did not pass",
        statusCode: res.status,
        context: { status: res.status, bodyExcerpt: body },
      });
      return;
    }
    console.log(`[cron] burst-cap-selftest ${body}`);
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "burst cap self-test call threw",
      error,
    });
  }
}
