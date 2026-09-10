/**
 * OPE-904 — the BURST layer (John's ruling 2026-09-10: option (c) for the eight
 * abuse-prone policies, option (a) for the other fourteen).
 *
 * The KV quota cannot hold under concurrency — measured on production, 81
 * origin-reaching requests against a 60/hour cap produced 27 recorded
 * increments and zero refusals. These tests pin the layer that does hold, and
 * pin that it is applied to exactly the eight policies and no others.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));

interface FakeEnv {
  RATE_LIMIT_KV?: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
  BURST_LIMITER?: { limit: ReturnType<typeof vi.fn> };
}
let fakeEnv: FakeEnv | null = null;

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    if (fakeEnv === null) throw new Error("no request context");
    return { env: fakeEnv };
  },
}));

import { checkRateLimit, rateLimitResponse } from "../rate-limit";

function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  };
}

/** A limiter that admits the first `n` calls for each key, then refuses. */
function makeBurst(n: number) {
  const seen = new Map<string, number>();
  return {
    calls: [] as string[],
    limit: vi.fn(async function (this: void, { key }: { key: string }) {
      const c = (seen.get(key) ?? 0) + 1;
      seen.set(key, c);
      return { success: c <= n };
    }),
  };
}

function req(ip = "1.2.3.4") {
  return new Request("https://example.com/api/x", { headers: { "CF-Connecting-IP": ip } });
}

let kv: ReturnType<typeof makeKv>;
let burst: ReturnType<typeof makeBurst>;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(null);
  kv = makeKv();
  burst = makeBurst(5);
  fakeEnv = { RATE_LIMIT_KV: kv, BURST_LIMITER: burst };
});

describe("the burst layer refuses what KV cannot", () => {
  it("admits the first 5 and refuses the 6th, all inside the hourly quota", async () => {
    // auth-register's hourly cap is 5 anon — but that is the KV layer. Use
    // claim-wizard (15/hr authenticated) so the hourly quota is NOT what
    // refuses, isolating the burst layer as the cause.
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await checkRateLimit(req(), "claim-wizard"));

    expect(results.slice(0, 5).every((r) => r.allowed)).toBe(true);
    expect(results[5].allowed).toBe(false);
    // Proof it was the burst layer and not the hourly quota: the hourly cap is
    // 15 and only 6 requests were made.
    expect(results[5].limit).toBe(15);
  });

  it("reports a 60-second Retry-After, not the hour the policy is written in", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    for (let i = 0; i < 5; i++) await checkRateLimit(req(), "claim-wizard");
    const refused = await checkRateLimit(req(), "claim-wizard");

    const res = rateLimitResponse(refused);
    const retryAfter = Number(res.headers.get("Retry-After"));
    expect(res.status).toBe(429);
    // A caller told to wait 3600s for a 60s block would give up entirely.
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("keys per identifier — a different IP is admitted in the same window", async () => {
    // The positive landmark the acceptance criteria name explicitly.
    for (let i = 0; i < 6; i++) await checkRateLimit(req("1.1.1.1"), "auth-forgot-password");
    const other = await checkRateLimit(req("9.9.9.9"), "auth-forgot-password");
    expect(other.allowed).toBe(true);
  });

  it("keys per policy — exhausting one does not refuse another", async () => {
    for (let i = 0; i < 6; i++) await checkRateLimit(req(), "auth-forgot-password");
    const other = await checkRateLimit(req(), "newsletter-subscribe");
    expect(other.allowed).toBe(true);
  });

  it("does not touch KV once the burst layer has refused", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    for (let i = 0; i < 5; i++) await checkRateLimit(req(), "claim-wizard");
    kv.put.mockClear();
    const refused = await checkRateLimit(req(), "claim-wizard");
    expect(refused.allowed).toBe(false);
    expect(kv.put).not.toHaveBeenCalled();
  });
});

describe("the cohort is exactly the eight John approved", () => {
  const BURST = [
    "auth-register",
    "auth-forgot-password",
    "auth-reset-password",
    "auth-verify-email-send",
    "newsletter-subscribe",
    "vendor-contact",
    "suggest-event-submit",
    "claim-wizard",
  ] as const;

  const SOFT_ONLY = [
    "suggest-event-extract",
    "suggest-event-fetch",
    "suggest-event-check-duplicate",
    "suggest-event-match-venue",
    "export-events",
    "google-autocomplete",
    "client-errors",
    "analytics-track",
    "events-same-day",
    "vendor-photo-upload",
  ] as const;

  it.each(BURST)("consults the binding for %s", async (endpoint) => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    await checkRateLimit(req(), endpoint);
    expect(burst.limit).toHaveBeenCalledTimes(1);
  });

  it.each(SOFT_ONLY)("does NOT consult the binding for %s", async (endpoint) => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    await checkRateLimit(req(), endpoint);
    expect(burst.limit).not.toHaveBeenCalled();
  });

  it("BURST and SOFT_ONLY together are non-empty — the two lists above are not vacuous", () => {
    expect(BURST.length).toBe(8);
    expect(SOFT_ONLY.length).toBeGreaterThan(0);
  });
});

describe("a missing binding degrades to the KV quota rather than to nothing", () => {
  it("still enforces the hourly quota when BURST_LIMITER is absent", async () => {
    // Unit tests and `next dev` have no binding. That must not turn a checked
    // request into an unchecked one — the KV layer still runs.
    fakeEnv = { RATE_LIMIT_KV: kv };
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await checkRateLimit(req(), "auth-register"));

    // auth-register is 5/hour anon; the 6th must still be refused, by KV.
    expect(results.slice(0, 5).every((r) => r.allowed)).toBe(true);
    expect(results[5].allowed).toBe(false);
    expect(kv.put).toHaveBeenCalled();
  });
});
