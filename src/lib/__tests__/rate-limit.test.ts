import { describe, it, expect, vi, beforeEach } from "vitest";

// We need to mock both `auth()` and `getRequestContext()` because
// checkRateLimit branches on session state AND on the runtime env
// (KV availability, production-vs-dev detection).
//
// Each test wires up fresh mocks via the helpers below so failures
// stay isolated.

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

interface FakeKv {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
}

interface FakeEnv {
  RATE_LIMIT_KV?: FakeKv;
  CF_PAGES?: string;
}

let fakeEnv: FakeEnv | null = null;

vi.mock("@cloudflare/next-on-pages", () => ({
  getRequestContext: () => {
    if (fakeEnv === null) throw new Error("no request context");
    return { env: fakeEnv };
  },
}));

import { checkRateLimit, rateLimitResponse, type RateLimitResult } from "../rate-limit";

function makeKv(initial: Record<string, string> = {}): FakeKv {
  const store = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
}

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/api/x", { headers });
}

describe("checkRateLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeEnv = null;
    mockAuth.mockResolvedValue(null);
  });

  describe("KV unavailable", () => {
    it("allows the request in dev when KV binding is missing", async () => {
      fakeEnv = {}; // no RATE_LIMIT_KV, no CF_PAGES → dev fallback
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await checkRateLimit(makeRequest(), "newsletter-subscribe");

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(10);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("denies the request in production when KV binding is missing", async () => {
      // CF_PAGES presence is the runtime signal that we're on Cloudflare;
      // we never want to silently fail-open in prod since that defeats
      // the whole purpose of the limiter.
      fakeEnv = { CF_PAGES: "1" };
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await checkRateLimit(makeRequest(), "newsletter-subscribe");

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it("allows the request when getRequestContext throws (test/local environment)", async () => {
      fakeEnv = null; // forces getRequestContext to throw
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await checkRateLimit(makeRequest(), "newsletter-subscribe");

      expect(result.allowed).toBe(true);
      warnSpy.mockRestore();
    });
  });

  describe("under-limit happy path", () => {
    it("allows a first request and writes one timestamp to KV", async () => {
      const kv = makeKv();
      fakeEnv = { RATE_LIMIT_KV: kv };

      const result = await checkRateLimit(makeRequest(), "newsletter-subscribe");

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(10);
      expect(result.remaining).toBe(9);
      expect(kv.put).toHaveBeenCalledTimes(1);

      const [putKey, putValue] = kv.put.mock.calls[0] as [string, string];
      expect(putKey).toMatch(/^rate:newsletter-subscribe:ip:/);
      const stored = JSON.parse(putValue) as number[];
      expect(stored).toHaveLength(1);
    });

    it("uses CF-Connecting-IP for the identifier when present", async () => {
      const kv = makeKv();
      fakeEnv = { RATE_LIMIT_KV: kv };

      await checkRateLimit(
        makeRequest({ "CF-Connecting-IP": "203.0.113.5" }),
        "newsletter-subscribe"
      );

      const [putKey] = kv.put.mock.calls[0] as [string, string];
      expect(putKey).toBe("rate:newsletter-subscribe:ip:203.0.113.5");
    });

    it("falls back to X-Forwarded-For when CF-Connecting-IP is absent", async () => {
      const kv = makeKv();
      fakeEnv = { RATE_LIMIT_KV: kv };

      await checkRateLimit(
        makeRequest({ "X-Forwarded-For": "198.51.100.7, 10.0.0.1" }),
        "newsletter-subscribe"
      );

      const [putKey] = kv.put.mock.calls[0] as [string, string];
      // Takes the first IP in the comma-separated list.
      expect(putKey).toBe("rate:newsletter-subscribe:ip:198.51.100.7");
    });

    it("uses 'unknown' identifier when no IP headers are present", async () => {
      const kv = makeKv();
      fakeEnv = { RATE_LIMIT_KV: kv };

      await checkRateLimit(makeRequest(), "newsletter-subscribe");

      const [putKey] = kv.put.mock.calls[0] as [string, string];
      expect(putKey).toBe("rate:newsletter-subscribe:ip:unknown");
    });

    it("uses authenticated limit + user identifier when a session exists", async () => {
      mockAuth.mockResolvedValue({ user: { id: "user-42" } });
      const kv = makeKv();
      fakeEnv = { RATE_LIMIT_KV: kv };

      const result = await checkRateLimit(makeRequest(), "suggest-event-submit");

      expect(result.isAuthenticated).toBe(true);
      expect(result.limit).toBe(10); // authenticatedLimit for suggest-event-submit
      const [putKey] = kv.put.mock.calls[0] as [string, string];
      expect(putKey).toBe("rate:suggest-event-submit:user:user-42");
    });
  });

  describe("over-limit denial", () => {
    it("denies once the stored window is full and does not write", async () => {
      const now = Date.now();
      // 10 timestamps within the last hour — fills the
      // newsletter-subscribe window (limit 10).
      const stored = JSON.stringify(Array.from({ length: 10 }, (_, i) => now - i * 1000));
      const kv = makeKv({
        "rate:newsletter-subscribe:ip:1.2.3.4": stored,
      });
      fakeEnv = { RATE_LIMIT_KV: kv };

      const result = await checkRateLimit(
        makeRequest({ "CF-Connecting-IP": "1.2.3.4" }),
        "newsletter-subscribe"
      );

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      // Crucially: don't increment when denied — that would extend
      // the punishment window indefinitely under sustained abuse.
      expect(kv.put).not.toHaveBeenCalled();
    });

    it("filters timestamps outside the sliding window so old hits don't count", async () => {
      const now = Date.now();
      // Mix of stale (>1h old) and fresh timestamps. The stale ones
      // should be dropped, leaving room under the limit.
      const stored = JSON.stringify([
        now - 4 * 60 * 60 * 1000, // 4h ago — outside the 1h window
        now - 3 * 60 * 60 * 1000, // 3h ago — outside
        now - 30 * 1000, // 30s ago — inside
      ]);
      const kv = makeKv({
        "rate:newsletter-subscribe:ip:5.6.7.8": stored,
      });
      fakeEnv = { RATE_LIMIT_KV: kv };

      const result = await checkRateLimit(
        makeRequest({ "CF-Connecting-IP": "5.6.7.8" }),
        "newsletter-subscribe"
      );

      expect(result.allowed).toBe(true);
      // 1 fresh timestamp + 1 new = 2 used out of 10
      expect(result.remaining).toBe(8);

      const [, putValue] = kv.put.mock.calls[0] as [string, string];
      const newStored = JSON.parse(putValue) as number[];
      // Stale timestamps are pruned, only fresh + new remain.
      expect(newStored).toHaveLength(2);
    });
  });

  describe("KV failure", () => {
    it("fails open and allows the request when KV throws", async () => {
      const kv: FakeKv = {
        get: vi.fn(async () => {
          throw new Error("KV transient error");
        }),
        put: vi.fn(),
      };
      fakeEnv = { RATE_LIMIT_KV: kv };
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await checkRateLimit(makeRequest(), "newsletter-subscribe");

      expect(result.allowed).toBe(true);
      expect(errSpy).toHaveBeenCalledWith("[Rate Limit] KV error:", expect.any(Error));
      errSpy.mockRestore();
    });
  });
});

describe("rateLimitResponse", () => {
  it("returns a 429 with Retry-After and X-RateLimit-* headers", async () => {
    const result: RateLimitResult = {
      allowed: false,
      remaining: 0,
      limit: 10,
      resetAt: Math.floor(Date.now() / 1000) + 600, // 10 minutes from now
      isAuthenticated: false,
    };

    const response = rateLimitResponse(result);

    expect(response.status).toBe(429);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(response.headers.get("X-RateLimit-Reset")).toBe(String(result.resetAt));

    const retryAfter = Number(response.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(600);

    const body = (await response.json()) as { success: boolean; error: string; retryAfter: number };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/too many requests/i);
  });

  it("clamps Retry-After to 0 when the reset time is already in the past", async () => {
    const result: RateLimitResult = {
      allowed: false,
      remaining: 0,
      limit: 5,
      resetAt: Math.floor(Date.now() / 1000) - 30, // 30s ago
      isAuthenticated: false,
    };

    const response = rateLimitResponse(result);
    expect(response.headers.get("Retry-After")).toBe("0");
  });
});
