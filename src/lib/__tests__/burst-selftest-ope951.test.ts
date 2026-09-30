/**
 * OPE-951 — the production self-test's verdict, and the route's wiring.
 *
 * The verdict must fail on BOTH broken shapes: a cap that refuses nothing
 * (what the Workers Rate Limiting binding did in production) and a cap that
 * refuses everything. And the route must stamp the heartbeat ONLY on a pass —
 * a stamp written on a failure would keep the probe green over a dead cap,
 * which is the whole defect again.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runBurstSelfTest } from "../burst-selftest";
import type { BurstLimiter } from "../rate-limit";

/** A limiter that admits `n` per key, then refuses with the given Retry-After. */
function capped(n: number, retryAfterSeconds = 60): BurstLimiter {
  const seen = new Map<string, number>();
  return {
    limit: async ({ key }) => {
      const c = (seen.get(key) ?? 0) + 1;
      seen.set(key, c);
      return { success: c <= n, retryAfterSeconds };
    },
  };
}

describe("runBurstSelfTest — the verdict", () => {
  it("PASSES a cap that admits 5 and refuses the 6th", async () => {
    const r = await runBurstSelfTest(capped(5), "selftest:a");
    expect(r).toMatchObject({ pass: true, reason: "ok", refusalRetryAfterSeconds: 60 });
    expect(r.successes).toEqual([true, true, true, true, true, false]);
  });

  it("FAILS an inert cap that admits everything — the OPE-951 production shape", async () => {
    const inert: BurstLimiter = { limit: async () => ({ success: true }) };
    const r = await runBurstSelfTest(inert, "selftest:b");
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/NOT refused/);
  });

  it("FAILS a cap that refuses everything", async () => {
    const r = await runBurstSelfTest(capped(0), "selftest:c");
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/first 5/);
  });

  it("FAILS with no binding", async () => {
    const r = await runBurstSelfTest(null, "selftest:d");
    expect(r).toMatchObject({ pass: false, reason: "no BURST_COUNTER binding" });
  });

  it("FAILS a refusal whose Retry-After is outside the window", async () => {
    const r = await runBurstSelfTest(capped(5, 3600), "selftest:e");
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/Retry-After 3600/);
  });
});

// ── the route ───────────────────────────────────────────────────────────────

const limiterState: { limiter: BurstLimiter | null } = { limiter: null };
const logError = vi.fn(async (..._a: unknown[]) => {});
const onConflictDoUpdate = vi.fn(async (..._a: unknown[]) => {});
const values = vi.fn((..._a: unknown[]) => ({ onConflictDoUpdate }));
const insert = vi.fn((..._a: unknown[]) => ({ values }));

vi.mock("@/lib/api/with-auth", () => ({
  withInternalKey: (optsOrHandler: unknown, handler?: unknown) => handler ?? optsOrHandler,
}));
vi.mock("@/lib/logger", () => ({ logError: (...a: unknown[]) => logError(...a) }));
vi.mock("@/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("../rate-limit")>()),
  getBurstLimiter: () => limiterState.limiter,
}));

const { POST } = await import("@/app/api/internal/burst-selftest/route");
const call = () =>
  (POST as unknown as (a: unknown) => Promise<Response>)({ db: { insert }, request: {} });

beforeEach(() => vi.clearAllMocks());

describe("POST /api/internal/burst-selftest — wiring", () => {
  it("a PASS stamps watchdog:burst-cap-selftest and answers 200", async () => {
    limiterState.limiter = capped(5);
    const res = await call();
    expect(res.status).toBe(200);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(values.mock.calls[0][0]).toMatchObject({
      agentCode: "watchdog:burst-cap-selftest",
      kind: "watchdog",
    });
    expect(logError).not.toHaveBeenCalled();
  });

  it("a FAIL writes NO stamp, logs an error, and answers 500", async () => {
    limiterState.limiter = { limit: async () => ({ success: true }) };
    const res = await call();
    expect(res.status).toBe(500);
    expect(insert).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("uses a FRESH key every run, so it never shares a real caller's bucket", async () => {
    const keys: string[] = [];
    limiterState.limiter = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: keys.filter((k) => k === key).length <= 5, retryAfterSeconds: 60 };
      },
    };
    await call();
    await call();
    const distinct = [...new Set(keys)];
    expect(distinct).toHaveLength(2);
    expect(distinct.every((k) => k.startsWith("selftest:"))).toBe(true);
  });
});
