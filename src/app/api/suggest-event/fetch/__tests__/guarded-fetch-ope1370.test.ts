/**
 * OPE-1370 (SSRF4) — the public suggest-event fetch must not be an open proxy:
 * the shared SSRF guard on every redirect hop, a body cap, and the ordinary
 * anonymous flow still working.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true }),
  rateLimitResponse: () => null,
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => ({}) }));

const { GET } = await import("../route");
// Mirrors the route constant (route files may only export route fields).
const SUGGEST_FETCH_MAX_BYTES = 3 * 1024 * 1024;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(impl: (url: string) => Response) {
  const spy = vi.fn(async (input: RequestInfo | URL) => impl(String(input)));
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

const call = (url: string) =>
  GET(
    new NextRequest(
      `https://meetmeatthefair.com/api/suggest-event/fetch?url=${encodeURIComponent(url)}`
    )
  );

const page = () =>
  new Response(
    "<html><head><title>Harvest Fair</title></head><body>Harvest Fair, Saturday 9-4</body></html>",
    { status: 200, headers: { "content-type": "text/html" } }
  );

describe("/api/suggest-event/fetch", () => {
  it("still fetches an ordinary public page for an anonymous user", async () => {
    stubFetch(() => page());
    const res = await call("https://fair.example.org/");
    const body = (await res.json()) as { success: boolean; title: string; content: string };
    expect(body.success).toBe(true);
    expect(body.title).toBe("Harvest Fair");
    expect(body.content).toContain("Saturday 9-4");
  });

  for (const target of ["http://127.0.0.1/", "http://[::7f00:1]/", "http://localhost./"]) {
    it(`refuses a redirect to ${target} at hop 2, without requesting it`, async () => {
      const spy = stubFetch((u) =>
        u === "https://fair.example.org/"
          ? new Response(null, { status: 302, headers: { location: target } })
          : page()
      );
      const res = await call("https://fair.example.org/");
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("Internal URLs are not allowed");
      expect(spy).toHaveBeenCalledTimes(1);
    });
  }

  it("refuses the old inline validator's misses on the first hop", async () => {
    const spy = stubFetch(() => page());
    for (const u of ["http://localhost./", "http://[::7f00:1]/", "http://[::ffff:7f00:1]/"]) {
      expect((await call(u)).status).toBe(400);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("aborts an oversize body instead of reading it whole", async () => {
    let sent = 0;
    stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              if (sent > SUGGEST_FETCH_MAX_BYTES * 4) return c.close();
              sent += 64 * 1024;
              c.enqueue(new Uint8Array(64 * 1024).fill(0x61));
            },
          }),
          { status: 200, headers: { "content-type": "text/html" } }
        )
    );
    const body = (await (await call("https://big.example/")).json()) as {
      success: boolean;
      error: string;
    };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/too large/);
    expect(sent).toBeLessThan(SUGGEST_FETCH_MAX_BYTES * 2);
  });
});
