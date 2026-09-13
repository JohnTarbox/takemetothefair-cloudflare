// @vitest-environment node
/**
 * OPE-972 — the three routes that spend metered Browser Rendering / Workers AI
 * per call have a ceiling, and cannot spend when the ceiling is unknowable.
 *
 * Each route is driven through the real `checkRateLimit` against an in-memory
 * KV, seeded to one call below its threshold:
 *   - that call still RENDERS / still OCRs (positive landmark — the limit counts
 *     the right thing and has not simply broken the endpoint);
 *   - the next call is a 429 with Retry-After, and spends nothing.
 * Then with no KV, and with a KV that throws, all three refuse (fail-closed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { RATE_LIMITS } from "@/lib/rate-limit";

type Kv = {
  get: (k: string) => Promise<string | null>;
  put: (k: string, v: string) => Promise<void>;
};
const state: { kv: Kv | null; ai: unknown } = { kv: null, ai: null };

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: { RATE_LIMIT_KV: state.kv ?? undefined, AI: state.ai } }),
}));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => ({}),
  getCloudflareEnv: () => ({
    INTERNAL_API_KEY: "test-key",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    CLOUDFLARE_BROWSER_RENDERING_TOKEN: "br-token",
  }),
  getCloudflareAi: () => state.ai,
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => {}) }));
vi.mock("@/lib/browser-rendering-attempt", () => ({
  recordBrowserRenderingAttempt: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }));

const { POST: harvestPost } = await import("../internal/harvest-fetch/route");
const { GET: importFetchGet } = await import("../admin/import-url/fetch/route");
const { POST: extractImagePost } = await import("../admin/import-url/extract-image/route");

const CALLER = "scheduled";
const ctx = { params: Promise.resolve({}) };
const HEADERS = { "x-internal-key": "test-key", "x-mmatf-entrypoint": CALLER };
const PAGE = `<!doctype html><html><head><title>Kingfield Craft Fair</title></head><body><main><h1>Kingfield Craft Fair</h1><p>Saturday October 4, 2026, 9am to 4pm at the Kingfield Elementary School gym. Over 40 local makers, free admission.</p></main></body></html>`;

function memoryKv(): Kv & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => void store.set(k, v),
  };
}
/** Fill `endpoint`'s bucket for CALLER to one below its limit. */
function seedBelowLimit(kv: ReturnType<typeof memoryKv>, endpoint: keyof typeof RATE_LIMITS) {
  const limit = RATE_LIMITS[endpoint].authenticatedLimit;
  const now = Date.now();
  kv.store.set(
    `rate:${endpoint}:caller:${CALLER}`,
    JSON.stringify(Array.from({ length: limit - 1 }, (_, i) => now - 1000 - i))
  );
}

let spent: { browserRendering: number; ocr: number };
let originalFetch: typeof fetch;
beforeEach(() => {
  spent = { browserRendering: 0, ocr: 0 };
  originalFetch = globalThis.fetch;
  // Every origin WAF-blocks, so any call that gets past the limiter escalates
  // to (and is counted as) a billed Browser Rendering session.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("browser-rendering/content")) {
      spent.browserRendering++;
      return new Response(JSON.stringify({ success: true, result: PAGE }), { status: 200 });
    }
    return new Response("blocked", { status: 403 });
  }) as typeof fetch;
  state.ai = {
    toMarkdown: async () => {
      spent.ocr++;
      return [{ format: "markdown", data: "Fall Bazaar — September 12, 10am to 2pm" }];
    },
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const ROUTES = [
  {
    endpoint: "harvest-fetch" as const,
    metric: "browserRendering" as const,
    call: () =>
      harvestPost(
        new NextRequest("http://localhost/api/internal/harvest-fetch", {
          method: "POST",
          headers: { ...HEADERS, "content-type": "application/json" },
          body: JSON.stringify({ url: "https://visitrhodeisland.com/events/" }),
        }),
        ctx
      ),
  },
  {
    endpoint: "import-url-fetch" as const,
    metric: "browserRendering" as const,
    call: () =>
      importFetchGet(
        new NextRequest(
          "http://localhost/api/admin/import-url/fetch?url=" +
            encodeURIComponent("https://kingfieldfair.example.com/"),
          { headers: HEADERS }
        ),
        ctx
      ),
  },
  {
    endpoint: "import-url-extract-image" as const,
    metric: "ocr" as const,
    call: () => {
      const form = new FormData();
      form.append(
        "images",
        new File([new Uint8Array([1, 2, 3])], "poster.jpg", { type: "image/jpeg" })
      );
      return extractImagePost(
        new NextRequest("http://localhost/api/admin/import-url/extract-image", {
          method: "POST",
          headers: HEADERS,
          body: form,
        }),
        ctx
      );
    },
  },
];

describe.each(ROUTES)("OPE-972 — $endpoint", ({ endpoint, metric, call }) => {
  it("ACCEPTANCE: the call just below the threshold still spends (renders / OCRs); the next is a 429 with Retry-After and spends nothing", async () => {
    const kv = memoryKv();
    state.kv = kv;
    seedBelowLimit(kv, endpoint);

    const below = await call();
    expect(below.status).not.toBe(429);
    expect(spent[metric]).toBeGreaterThan(0); // positive landmark
    const spentBefore = spent[metric];

    const over = await call();
    expect(over.status).toBe(429);
    const retryAfter = Number(over.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(RATE_LIMITS[endpoint].windowMs / 1000);
    expect(spent[metric]).toBe(spentBefore);
  });

  it("counts under the caller entrypoint, not a shared IP bucket", async () => {
    const kv = memoryKv();
    state.kv = kv;
    await call();
    expect([...kv.store.keys()]).toContain(`rate:${endpoint}:caller:${CALLER}`);
  });

  it("ACCEPTANCE: FAIL-CLOSED — no quota backend refuses and spends nothing", async () => {
    state.kv = null;
    const res = await call();
    expect(res.status).toBe(429);
    expect(spent[metric]).toBe(0);
  });

  it("ACCEPTANCE: FAIL-CLOSED — a quota backend that throws refuses and spends nothing", async () => {
    state.kv = {
      get: async () => {
        throw new Error("KV unavailable");
      },
      put: async () => {},
    };
    const res = await call();
    expect(res.status).toBe(429);
    expect(spent[metric]).toBe(0);
  });
});

describe("OPE-972 — policy shape", () => {
  it("no metered policy was added to the BURST layer", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../../lib/rate-limit.ts", import.meta.url), "utf8")
    );
    const burst = src.slice(
      src.indexOf("const BURST_POLICIES"),
      src.indexOf("]);", src.indexOf("const BURST_POLICIES"))
    );
    expect(burst).toContain('"auth-register"'); // landmark: this IS the burst set
    for (const p of ["import-url-fetch", "import-url-extract-image", "harvest-fetch"]) {
      expect(burst).not.toContain(`"${p}"`);
    }
  });

  it("an admin session keys on the user id; an internal caller on its entrypoint; IP only as a last resort", async () => {
    const { meteredCallerIdentifier } = await import("@/lib/rate-limit");
    const r = (h: Record<string, string>) => new Request("http://x/", { headers: h });
    expect(meteredCallerIdentifier(r({ "x-mmatf-entrypoint": "queue" }), "u1")).toBe("user:u1");
    expect(meteredCallerIdentifier(r({ "x-mmatf-entrypoint": "queue" }), null)).toBe(
      "caller:queue"
    );
    expect(meteredCallerIdentifier(r({ "cf-connecting-ip": "203.0.113.9" }), null)).toMatch(/^ip:/);
  });
});
