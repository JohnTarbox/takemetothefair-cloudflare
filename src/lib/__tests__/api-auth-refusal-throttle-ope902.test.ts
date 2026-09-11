/**
 * OPE-902 follow-up — the internal-key refusal log must be bounded, durable,
 * and must not describe the real secret.
 *
 * Three defects shipped together in `9cbbea58`:
 *
 *  1. `void recordInternalKeyRefusal(...)` was neither awaited nor registered
 *     with `ctx.waitUntil`, so the Workers runtime could drop the write.
 *  2. `internalKeyMatches` runs BEFORE `checkRateLimit` on the public
 *     suggest-event routes, so an attacker-supplied `x-internal-key` header
 *     reached a D1 write ahead of every throttle in the system.
 *  3. The record stored `expectedLen` and `expectedFp` — the live secret's
 *     length and a fingerprint of it.
 *
 * Every refusal case below is paired with a positive landmark, because a
 * function that simply never wrote would satisfy the refusals on its own.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const envState: { INTERNAL_API_KEY?: string } = {};

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => ({}),
  getCloudflareEnv: () => envState,
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }));

/**
 * Typed to the shape the recorder actually calls, so `mock.calls[0][1]` is a
 * real tuple element rather than an index into `[]` — the zero-arg version of
 * this mock typechecked under vitest and failed `npm run typecheck`.
 */
interface LoggedEntry {
  level: string;
  source: string;
  message: string;
  statusCode: number;
  route: string;
  context: Record<string, unknown>;
}
const logError = vi.fn(async (_db: unknown, _entry: LoggedEntry) => {});
vi.mock("@/lib/logger", () => ({ logError }));

/** What the burst binding will answer, and what keys it was asked about. */
const limiterState: { binding: { limit: typeof limitFn } | null } = { binding: null };
const limitFn = vi.fn(async (_opts: { key: string }) => ({ success: true }));
vi.mock("@/lib/rate-limit", () => ({
  getBurstLimiter: () => limiterState.binding,
}));

const deployedState = { deployed: false };
vi.mock("@/lib/runtime-env", () => ({
  isDeployedEnvironment: () => deployedState.deployed,
}));

/** Every promise handed to ctx.waitUntil, so a test can await the background work. */
const registered: Promise<unknown>[] = [];
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        registered.push(p);
      },
    },
  }),
}));

import { internalKeyMatches } from "../api-auth";

const REAL_KEY = "the-real-internal-api-key-value-0001";

beforeEach(() => {
  vi.clearAllMocks();
  registered.length = 0;
  envState.INTERNAL_API_KEY = REAL_KEY;
  limiterState.binding = { limit: limitFn };
  limitFn.mockResolvedValue({ success: true });
  deployedState.deployed = true;
});

function req(path: string, key?: string): Request {
  return new Request(`https://meetmeatthefair.com${path}`, {
    method: "POST",
    headers: key === undefined ? {} : { "x-internal-key": key },
  });
}

/** Drive one refusal and run the work that was registered for after the response. */
async function refuseAndSettle(path = "/api/suggest-event/submit", key = "wrong-key") {
  const answer = await internalKeyMatches(req(path, key));
  await Promise.all(registered);
  return answer;
}

describe("the record survives the response", () => {
  it("registers the write with ctx.waitUntil rather than firing and forgetting", async () => {
    await internalKeyMatches(req("/api/suggest-event/submit", "wrong-key"));
    // The old code was `void recordInternalKeyRefusal(...)`: nothing was ever
    // handed to the runtime, so this array stayed empty and the write was
    // free to be torn down with the response.
    expect(registered).toHaveLength(1);
    await Promise.all(registered);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("does not make the caller wait for the write", async () => {
    let settled = false;
    logError.mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            settled = true;
            resolve();
          }, 10)
        )
    );
    await internalKeyMatches(req("/api/suggest-event/submit", "wrong-key"));
    // The auth answer came back while the D1 write was still in flight.
    expect(settled).toBe(false);
    await Promise.all(registered);
    expect(settled).toBe(true);
  });
});

describe("the write is budgeted per route", () => {
  it("spends the budget against a route-scoped key", async () => {
    await refuseAndSettle("/api/suggest-event/submit");
    expect(limitFn).toHaveBeenCalledWith({
      key: "internal-key-refusal:/api/suggest-event/submit",
    });
  });

  it("uses a DIFFERENT key per route, so a flood on one cannot starve another", async () => {
    await refuseAndSettle("/api/suggest-event/submit");
    await refuseAndSettle("/api/suggest-event/check-duplicate");
    const keys = limitFn.mock.calls.map((c) => c[0].key);
    expect(new Set(keys).size).toBe(2);
  });

  it("writes NOTHING when the budget is spent — and still answers the auth question", async () => {
    limitFn.mockResolvedValue({ success: false });
    const answer = await refuseAndSettle();
    expect(logError).not.toHaveBeenCalled();
    // The whole point: throttling the diagnostic must not change the verdict.
    expect(answer).toBe(false);
  });

  it("spends nothing but the limiter call when refused — no digest, no D1", async () => {
    limitFn.mockResolvedValue({ success: false });
    await refuseAndSettle();
    expect(limitFn).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
  });

  it("treats a THROWING limiter as no budget", async () => {
    limitFn.mockRejectedValue(new Error("binding exploded"));
    const answer = await refuseAndSettle();
    expect(logError).not.toHaveBeenCalled();
    expect(answer).toBe(false);
  });
});

describe("the missing-binding branch fails CLOSED on a deployed Worker", () => {
  it("writes nothing when deployed with no binding", async () => {
    limiterState.binding = null;
    deployedState.deployed = true;
    await refuseAndSettle();
    // OPE-931's defect in miniature: if this returned true on a missing
    // binding, production would be back to unbounded writes.
    expect(logError).not.toHaveBeenCalled();
  });

  it("POSITIVE LANDMARK: still writes off a deployed Worker, where the diagnostic is read", async () => {
    limiterState.binding = null;
    deployedState.deployed = false;
    await refuseAndSettle();
    expect(logError).toHaveBeenCalledTimes(1);
  });
});

describe("the record describes the PRESENTED value and nothing about the real secret", () => {
  async function contextOf(): Promise<Record<string, unknown>> {
    await refuseAndSettle();
    return logError.mock.calls[0][1].context;
  }

  it("no longer carries the real key's length or fingerprint", async () => {
    const ctx = await contextOf();
    // Both were an offline oracle: length plus a 32-bit fingerprint lets a
    // candidate key be tested without touching the server.
    expect(ctx).not.toHaveProperty("expectedLen");
    expect(ctx).not.toHaveProperty("expectedFp");
  });

  it("POSITIVE LANDMARK: still records what arrived, and whether a secret is configured", async () => {
    const ctx = await contextOf();
    expect(ctx.presentedLen).toBe("wrong-key".length);
    expect(ctx.presentedFp).toMatch(/^[0-9a-f]{8}$/);
    // The one fact about the expected side worth keeping — it separates
    // "receiver has no secret" from "receiver has a different one", which is
    // the distinction OPE-258 could not make.
    expect(ctx.expectedPresent).toBe(true);
  });

  it("reports expectedPresent=false when the receiver has no secret at all", async () => {
    envState.INTERNAL_API_KEY = undefined;
    const ctx = await contextOf();
    expect(ctx.expectedPresent).toBe(false);
  });
});

describe("the paths that must not log at all", () => {
  it("a CORRECT key returns true and records nothing", async () => {
    const answer = await internalKeyMatches(req("/api/suggest-event/submit", REAL_KEY));
    await Promise.all(registered);
    expect(answer).toBe(true);
    expect(logError).not.toHaveBeenCalled();
    // Not even the limiter is touched on the success path.
    expect(limitFn).not.toHaveBeenCalled();
  });

  it("NO key header at all returns false and records nothing", async () => {
    const answer = await internalKeyMatches(req("/api/suggest-event/submit"));
    await Promise.all(registered);
    expect(answer).toBe(false);
    // Ordinary unauthenticated traffic and internet background noise must
    // never reach the diagnostic — this is what keeps the budget for callers
    // that genuinely tried to authenticate.
    expect(logError).not.toHaveBeenCalled();
    expect(limitFn).not.toHaveBeenCalled();
  });
});
