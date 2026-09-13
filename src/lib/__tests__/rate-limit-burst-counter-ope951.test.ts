/**
 * OPE-951 + OPE-970 — the burst layer on the Durable Object counter, and what
 * happens when that counter fails.
 *
 * ⚠️ Read the limits of these tests before trusting them. Everything below the
 * `getBurstLimiter()` adapter is a fake, and the OPE-904 tests that faked the
 * old binding passed for the entire time that binding was inert in
 * production. A mock can only test its caller. The production proof for
 * OPE-951 is the daily self-test (`/api/internal/burst-selftest`) and its
 * heartbeat probe, not this file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth(), hashPassword: vi.fn() }));

interface FakeEnv {
  RATE_LIMIT_KV?: ReturnType<typeof makeKv>;
  BURST_COUNTER?: ReturnType<typeof makeNamespace>;
}
let fakeEnv: FakeEnv | null = null;

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    if (fakeEnv === null) throw new Error("no request context");
    return { env: fakeEnv, ctx: { waitUntil: () => {} } };
  },
}));

import {
  BURST_LIMIT,
  BURST_WINDOW_SECONDS,
  checkRateLimit,
  getBurstLimiter,
  rateLimitResponse,
} from "../rate-limit";

function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  };
}

type Hit = (
  limit: number,
  period: number
) => Promise<{ success: boolean; count: number; retryAfterSeconds: number }>;

function makeNamespace(hit: Hit) {
  const stub = { hit: vi.fn(hit) };
  return {
    stub,
    idFromName: vi.fn((name: string) => `id:${name}`),
    get: vi.fn((_id: string) => stub),
  };
}

function req(ip = "1.2.3.4") {
  return new Request("https://example.com/api/x", { headers: { "CF-Connecting-IP": ip } });
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(null);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleError.mockRestore());

describe("OPE-951 — getBurstLimiter adapts the Durable Object namespace", () => {
  it("routes by KEY and asks the counter for the production limit and window", async () => {
    const ns = makeNamespace(async () => ({ success: true, count: 1, retryAfterSeconds: 60 }));
    fakeEnv = { BURST_COUNTER: ns };

    const r = await getBurstLimiter()!.limit({ key: "rate:auth-register:ip:1.2.3.4" });

    expect(ns.idFromName).toHaveBeenCalledWith("rate:auth-register:ip:1.2.3.4");
    expect(ns.get).toHaveBeenCalledWith("id:rate:auth-register:ip:1.2.3.4");
    expect(ns.stub.hit).toHaveBeenCalledWith(BURST_LIMIT, BURST_WINDOW_SECONDS);
    expect([BURST_LIMIT, BURST_WINDOW_SECONDS]).toEqual([5, 60]);
    expect(r).toEqual({ success: true, retryAfterSeconds: 60 });
  });

  it("returns null with no binding, and null outside a request context", () => {
    fakeEnv = {};
    expect(getBurstLimiter()).toBeNull();
    fakeEnv = null;
    expect(getBurstLimiter()).toBeNull();
  });
});

describe("OPE-970 — a THROWING counter falls through to the KV quota", () => {
  it("resolves with the KV layer's decision instead of rejecting", async () => {
    const kv = makeKv();
    const ns = makeNamespace(async () => {
      throw new Error("Durable Object reset because its code was updated");
    });
    fakeEnv = { RATE_LIMIT_KV: kv, BURST_COUNTER: ns };

    const result = await checkRateLimit(req(), "auth-register");

    expect(result.allowed).toBe(true);
    // Positive landmark: the throw really happened on the burst path, AND the
    // KV quota really ran afterwards — so this is not a test that routed around
    // the burst layer.
    expect(ns.stub.hit).toHaveBeenCalledTimes(1);
    expect(kv.get).toHaveBeenCalledWith("rate:auth-register:ip:1.2.3.4");
    expect(kv.put).toHaveBeenCalledTimes(1);
  });

  it("logs the failure with the endpoint name — never silently", async () => {
    fakeEnv = {
      RATE_LIMIT_KV: makeKv(),
      BURST_COUNTER: makeNamespace(async () => {
        throw new Error("boom");
      }),
    };
    await checkRateLimit(req(), "vendor-contact");
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("vendor-contact"),
      expect.any(Error)
    );
  });

  it("a throwing counter still leaves the hourly quota able to refuse", async () => {
    fakeEnv = {
      RATE_LIMIT_KV: makeKv(),
      BURST_COUNTER: makeNamespace(async () => {
        throw new Error("boom");
      }),
    };
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await checkRateLimit(req(), "auth-register"));
    // auth-register is 5/hour anonymous in KV.
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, true, true, false]);
    // …and the KV refusal carries the HOUR, which is how the two layers are
    // told apart in production (≈3600 = KV, ≤60 = burst).
    expect(Number(rateLimitResponse(results[5]).headers.get("Retry-After"))).toBeGreaterThan(60);
  });
});

describe("OPE-970 positive landmark — a REFUSAL is not an error", () => {
  it("returns allowed:false with the counter's Retry-After, and never reaches KV", async () => {
    const kv = makeKv();
    fakeEnv = {
      RATE_LIMIT_KV: kv,
      BURST_COUNTER: makeNamespace(async () => ({
        success: false,
        count: 6,
        retryAfterSeconds: 17,
      })),
    };
    const nowS = Math.floor(Date.now() / 1000);
    const result = await checkRateLimit(req(), "auth-register");

    expect(result.allowed).toBe(false);
    expect(result.resetAt - nowS).toBeGreaterThanOrEqual(16);
    expect(result.resetAt - nowS).toBeLessThanOrEqual(18);
    expect(kv.get).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("clamps a nonsense Retry-After into (0, window]", async () => {
    fakeEnv = {
      RATE_LIMIT_KV: makeKv(),
      BURST_COUNTER: makeNamespace(async () => ({
        success: false,
        count: 6,
        retryAfterSeconds: 99_999,
      })),
    };
    const refused = await checkRateLimit(req(), "auth-register");
    const retryAfter = Number(rateLimitResponse(refused).headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(BURST_WINDOW_SECONDS);
  });
});
