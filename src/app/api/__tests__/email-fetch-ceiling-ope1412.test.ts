// @vitest-environment node
/**
 * OPE-1412 — a GLOBAL ceiling of EMAIL_FETCH_DAILY_CEILING (50) email-driven
 * URL fetches per UTC day, across all senders, on top of OPE-1370's per-sender
 * `import-url-fetch` buckets.
 *
 * Driven through the real route + real `checkRateLimit` against an in-memory
 * KV, with the origin fetch counted so "skipped" means the page was never
 * requested, not merely that the response was a 429.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { EMAIL_FETCH_DAILY_CEILING, RATE_LIMITS } from "@/lib/rate-limit";

type Kv = {
  get: (k: string) => Promise<string | null>;
  put: (k: string, v: string) => Promise<void>;
};
const state: { kv: Kv | null } = { kv: null };

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: { RATE_LIMIT_KV: state.kv ?? undefined } }),
}));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => ({}),
  getCloudflareEnv: () => ({ INTERNAL_API_KEY: "test-key" }),
}));
const logError = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/lib/logger", () => ({ logError: (...a: unknown[]) => logError(...a) }));
vi.mock("@/lib/browser-rendering-attempt", () => ({
  recordBrowserRenderingAttempt: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }));

const { GET } = await import("../admin/import-url/fetch/route");

const PAGE = `<!doctype html><html><head><title>Kingfield Craft Fair</title></head><body><main><h1>Kingfield Craft Fair</h1><p>Saturday October 4, 2026, 9am to 4pm at the Kingfield Elementary School gym. Over 40 local makers, free admission.</p></main></body></html>`;
const ctx = { params: Promise.resolve({}) };
const GLOBAL = "import-url-fetch-email-daily";

function memoryKv(): Kv & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => void store.set(k, v),
  };
}

/** A well-formed 32-hex sender hash, distinct per n (what submitFetch stamps). */
function senderHash(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function emailFetch(sender: string) {
  return GET(
    new NextRequest(
      "http://localhost/api/admin/import-url/fetch?url=" +
        encodeURIComponent("https://kingfieldfair.example.com/"),
      {
        headers: {
          "x-internal-key": "test-key",
          "x-mmatf-entrypoint": "workflow",
          "x-mmatf-sender": sender,
        },
      }
    ),
    ctx
  );
}

function ceilingLogs() {
  return logError.mock.calls.filter((c) =>
    String((c[1] as { message?: string }).message).includes("global daily ceiling")
  );
}

let originFetches: number;
let originalFetch: typeof fetch;
let kv: ReturnType<typeof memoryKv>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T10:15:00Z"));
  logError.mockClear();
  originFetches = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    originFetches++;
    return new Response(PAGE, { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  kv = memoryKv();
  state.kv = kv;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

/** Spend the whole day's ceiling with distinct senders (none near its own limit). */
async function exhaustToday(offset = 0) {
  for (let i = 0; i < EMAIL_FETCH_DAILY_CEILING; i++) {
    const res = await emailFetch(senderHash(offset + i));
    expect(res.status).toBe(200);
  }
}

describe("OPE-1412 — global daily ceiling on email-driven fetches", () => {
  it("the constant is the single source of the limit, and it is 50", () => {
    expect(EMAIL_FETCH_DAILY_CEILING).toBe(50);
    expect(RATE_LIMITS[GLOBAL].authenticatedLimit).toBe(EMAIL_FETCH_DAILY_CEILING);
  });

  it("ACCEPTANCE: the 51st fetch in a UTC day (from a NEW sender) is skipped and logged once", async () => {
    await exhaustToday();
    expect(originFetches).toBe(EMAIL_FETCH_DAILY_CEILING); // positive landmark: 50 really fetched
    expect(ceilingLogs()).toHaveLength(0);

    const res = await emailFetch(senderHash(9999));
    expect(res.status).toBe(429); // same refusal shape as the per-sender bucket → fetch-429
    expect(originFetches).toBe(EMAIL_FETCH_DAILY_CEILING); // page never requested
    expect(ceilingLogs()).toHaveLength(1);
    const [, opts] = ceilingLogs()[0] as [unknown, { context: Record<string, unknown> }];
    expect(opts.context).toMatchObject({ ceiling: 50, day: "2026-10-16", skippedToday: 1 });

    // Retry-After points at UTC midnight (the bucket's real reset), 13h45m away.
    expect(Number(res.headers.get("Retry-After"))).toBe(13 * 3600 + 45 * 60);
  });

  it("logs at most once per UTC hour, with the running count; a new hour logs again", async () => {
    await exhaustToday();
    for (let i = 0; i < 4; i++) {
      expect((await emailFetch(senderHash(5000 + i))).status).toBe(429);
    }
    expect(ceilingLogs()).toHaveLength(1);

    vi.setSystemTime(new Date("2026-10-16T11:01:00Z"));
    expect((await emailFetch(senderHash(6000))).status).toBe(429);
    expect(ceilingLogs()).toHaveLength(2);
    const [, opts] = ceilingLogs()[1] as [unknown, { context: Record<string, unknown> }];
    expect(opts.context.skippedToday).toBe(5);
    expect(originFetches).toBe(EMAIL_FETCH_DAILY_CEILING);
  });

  it("ACCEPTANCE: the per-sender limit still applies under the global one, and its refusals spend no global slot", async () => {
    const sender = senderHash(42);
    const perSenderLimit = RATE_LIMITS["import-url-fetch"].authenticatedLimit;
    const now = Date.now();
    kv.store.set(
      `rate:import-url-fetch:sender:${sender}`,
      JSON.stringify(Array.from({ length: perSenderLimit }, (_, i) => now - 1000 - i))
    );

    const res = await emailFetch(sender);
    expect(res.status).toBe(429);
    expect(originFetches).toBe(0);
    // Global has plenty of room — the refusal came from the per-sender bucket —
    // and that refusal did not consume a global slot.
    expect(kv.store.has(`rate:${GLOBAL}:global:2026-10-16`)).toBe(false);

    // Control: a different sender on the same day is still served.
    expect((await emailFetch(senderHash(43))).status).toBe(200);
    expect(originFetches).toBe(1);
    expect(JSON.parse(kv.store.get(`rate:${GLOBAL}:global:2026-10-16`)!)).toHaveLength(1);
  });

  it("ACCEPTANCE: the counter resets the next UTC day", async () => {
    vi.setSystemTime(new Date("2026-10-16T23:30:00Z"));
    await exhaustToday();
    expect((await emailFetch(senderHash(7000))).status).toBe(429);

    vi.setSystemTime(new Date("2026-10-17T00:00:30Z")); // 30.5 minutes later, new UTC day
    const res = await emailFetch(senderHash(7001));
    expect(res.status).toBe(200);
    expect(originFetches).toBe(EMAIL_FETCH_DAILY_CEILING + 1);
  });

  it("does not count fetches that are not email-driven (admin UI / internal entrypoint)", async () => {
    const res = await GET(
      new NextRequest(
        "http://localhost/api/admin/import-url/fetch?url=" +
          encodeURIComponent("https://kingfieldfair.example.com/"),
        { headers: { "x-internal-key": "test-key", "x-mmatf-entrypoint": "scheduled" } }
      ),
      ctx
    );
    expect(res.status).toBe(200);
    expect([...kv.store.keys()].some((k) => k.startsWith(`rate:${GLOBAL}:`))).toBe(false);
  });

  it("a refused URL (SSRF) spends no global slot", async () => {
    const res = await GET(
      new NextRequest(
        "http://localhost/api/admin/import-url/fetch?url=" +
          encodeURIComponent("http://127.0.0.1/"),
        {
          headers: {
            "x-internal-key": "test-key",
            "x-mmatf-entrypoint": "workflow",
            "x-mmatf-sender": senderHash(1),
          },
        }
      ),
      ctx
    );
    expect(res.status).toBe(400);
    expect(kv.store.has(`rate:${GLOBAL}:global:2026-10-16`)).toBe(false);
  });
});
