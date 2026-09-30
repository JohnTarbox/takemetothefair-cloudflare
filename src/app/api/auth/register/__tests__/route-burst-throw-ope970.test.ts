/**
 * OPE-970 — end to end through the route: when the burst counter THROWS, the
 * register route answers from the KV quota (a 429 once the hour is spent), and
 * never turns the limiter's failure into a 500.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null, hashPassword: vi.fn() }));

const kvStore = new Map<string, string>();
const hit = vi.fn(async () => {
  throw new Error("Durable Object storage is overloaded");
});
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: {
      RATE_LIMIT_KV: {
        get: async (k: string) => kvStore.get(k) ?? null,
        put: async (k: string, v: string) => void kvStore.set(k, v),
      },
      BURST_COUNTER: { idFromName: (n: string) => n, get: () => ({ hit }) },
    },
    ctx: { waitUntil: () => {} },
  }),
}));

import { POST } from "../route";

function registerRequest() {
  return new Request("https://meetmeatthefair.com/api/auth/register", {
    method: "POST",
    headers: { "CF-Connecting-IP": "203.0.113.7", "content-type": "application/json" },
    body: "{}",
  });
}

beforeEach(() => {
  kvStore.clear();
  hit.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("OPE-970 — register route with a throwing burst counter", () => {
  it("answers 429 from the KV quota, not 500", async () => {
    // Spend the hourly quota (auth-register: 5/hour anonymous) directly in KV.
    const now = Date.now();
    kvStore.set(
      "rate:auth-register:ip:203.0.113.7",
      JSON.stringify([1, 2, 3, 4, 5].map((i) => now - i))
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(registerRequest() as any);

    expect(hit).toHaveBeenCalledTimes(1); // the burst path was exercised, and threw
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(60); // the KV hour
  });
});
