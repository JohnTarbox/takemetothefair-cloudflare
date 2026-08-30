/**
 * OPE-489 — a concurrency gate for scheduled MCP → main-app calls.
 *
 * ## The failure this exists to stop
 *
 * The daily cron fires ~20 tasks inside ONE `Promise.all`, a dozen of which POST
 * to the main app. Cloudflare may serve those concurrent requests from a single
 * Worker isolate, and the 128 MB memory ceiling is per-ISOLATE, shared by every
 * in-flight request in it. So the heavy analytics sweeps did not each exhaust
 * memory on their own — they exhausted it *together*, and the isolate death took
 * down whatever else was in flight.
 *
 * The signature in `error_logs` is unmistakable and is what identified this:
 * four unrelated sweeps failing at the SAME SECOND (`08:31:25`, `06:01:19`) with
 * the same verbatim body, `"Worker exceeded memory limit."`. Four independent
 * jobs that each grew past a limit would not share a timestamp; four requests
 * dying inside one isolate do.
 *
 * ## Why a gate rather than paginating each sweep
 *
 * OPE-489 hypothesised unbounded in-memory accumulation inside each sweep. That
 * may well be worth doing later, but it is not what makes them fail together,
 * and fixing twelve read paths is a far larger and riskier change than bounding
 * how many run at once. The gate attacks the actual mechanism — simultaneity —
 * at the one place every caller passes through.
 *
 * Deliberately NOT a rate limiter: there is no delay and no budget. Tasks run in
 * arrival order, at most `MAX_CONCURRENT_MAIN_APP_CALLS` at a time, and the
 * queue drains as fast as the main app answers.
 */

/**
 * How many scheduled main-app calls may be in flight at once.
 *
 * 2, not 1: full serialisation would push the daily batch's wall-clock past what
 * a scheduled invocation should hold open, and the ceiling is memory, not
 * request count — a pair of sweeps sat comfortably inside 128 MB for the months
 * before the batch grew. 2 keeps headroom while still halving peak residency.
 */
export const MAX_CONCURRENT_MAIN_APP_CALLS = 2;

let active = 0;
const waiting: Array<() => void> = [];

/**
 * Run `fn` with a main-app slot held, releasing it even if `fn` throws.
 *
 * Module-level state is correct here: an isolate is exactly the unit whose
 * memory we are protecting, so a per-isolate counter is the right scope. A fresh
 * isolate starts empty, which is also right — it has its own 128 MB.
 */
export async function withMainAppSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT_MAIN_APP_CALLS) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    // Wake exactly one waiter; it increments `active` itself, so the count can
    // never exceed the cap even when several finish at once.
    waiting.shift()?.();
  }
}

/** True when the response body is Cloudflare's isolate OOM kill (OPE-489). */
export function isWorkerOom(bodyExcerpt: string | null | undefined): boolean {
  return typeof bodyExcerpt === "string" && bodyExcerpt.toLowerCase().includes("exceeded memory");
}

/**
 * OPE-641 — classify a non-2xx cron response.
 *
 * Three shapes, not two. An isolate OOM kill and an ordinary upstream error
 * were separated by OPE-489; this adds the case that was still ambiguous —
 * a 5xx that returns NO BODY AT ALL.
 *
 * gsc-metrics-sync failed 503-with-no-body on 2026-08-30, one day after a
 * confirmed `worker-oom` on the same endpoint in the same 06:02Z cron slot.
 * It matched neither branch and was filed as a plain `non-2xx`, i.e. the same
 * bucket as a genuine upstream error page. OPE-489 hit the same ambiguity from
 * the other direction: two sweeps failed 503-shaped and later CONVERGED onto
 * the memory 500.
 *
 * This deliberately does NOT guess which one an empty-body 5xx is. Naming it
 * is the point — an unclassifiable failure should say so rather than borrow a
 * label that implies a diagnosis nobody made.
 */
export type CronFailureCause = "worker-oom" | "5xx-no-body" | "non-2xx";

export function classifyCronFailure(status: number, bodyExcerpt: string): CronFailureCause {
  if (isWorkerOom(bodyExcerpt)) return "worker-oom";
  if (status >= 500 && bodyExcerpt.trim() === "") return "5xx-no-body";
  return "non-2xx";
}

/** Test-only: reset the gate between cases. */
export function __resetMainAppGate(): void {
  active = 0;
  waiting.length = 0;
}
