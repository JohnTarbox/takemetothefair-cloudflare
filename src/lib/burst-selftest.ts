/**
 * OPE-951 — prove, in production, that the burst cap actually refuses.
 *
 * The Workers Rate Limiting binding that OPE-904 shipped was bound, reachable
 * and green in every unit test — and returned `success: true` for every call in
 * production. Its tests mocked the binding, so they tested only the caller. A
 * cap that has stopped refusing looks exactly like a quiet day with no abuse.
 *
 * This self-test closes that gap by running the SHIPPED path, not a model of
 * it: `getBurstLimiter()` — the same function `checkRateLimit` and the
 * internal-key refusal log call — on a fresh throwaway key, `BURST_LIMIT + 1`
 * times. It passes only when the first `BURST_LIMIT` succeed AND the next one
 * is refused with a Retry-After inside the window. Both halves matter: a cap
 * that refuses everything is as broken as one that refuses nothing.
 *
 * A pass stamps `agent_heartbeats` (`watchdog:burst-cap-selftest`), which the
 * `burst-cap-selftest` heartbeat probe reads. A fail, or no run at all, leaves
 * the stamp to go stale and the probe escalates.
 */
import { BURST_LIMIT, BURST_WINDOW_SECONDS, type BurstLimiter } from "@/lib/rate-limit";

export const BURST_SELFTEST_AGENT_CODE = "watchdog:burst-cap-selftest";

export interface BurstSelfTestResult {
  pass: boolean;
  /** One entry per call, in order. */
  successes: boolean[];
  refusalRetryAfterSeconds: number | null;
  reason: string;
}

export async function runBurstSelfTest(
  limiter: BurstLimiter | null,
  key: string
): Promise<BurstSelfTestResult> {
  if (!limiter) {
    return {
      pass: false,
      successes: [],
      refusalRetryAfterSeconds: null,
      reason: "no BURST_COUNTER binding",
    };
  }

  const successes: boolean[] = [];
  let refusalRetryAfterSeconds: number | null = null;
  for (let i = 0; i < BURST_LIMIT + 1; i++) {
    const r = await limiter.limit({ key });
    successes.push(r.success);
    if (!r.success && refusalRetryAfterSeconds === null) {
      refusalRetryAfterSeconds = r.retryAfterSeconds ?? null;
    }
  }

  const admitted = successes.slice(0, BURST_LIMIT).every(Boolean);
  const refused = successes[BURST_LIMIT] === false;
  const retryOk =
    refusalRetryAfterSeconds !== null &&
    refusalRetryAfterSeconds > 0 &&
    refusalRetryAfterSeconds <= BURST_WINDOW_SECONDS;

  let reason = "ok";
  if (!admitted) reason = `refused within the first ${BURST_LIMIT} calls`;
  else if (!refused) reason = `call ${BURST_LIMIT + 1} was NOT refused — the cap is not enforcing`;
  else if (!retryOk)
    reason = `refusal Retry-After ${refusalRetryAfterSeconds} is outside (0, ${BURST_WINDOW_SECONDS}]`;

  return { pass: admitted && refused && retryOk, successes, refusalRetryAfterSeconds, reason };
}
