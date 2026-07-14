/**
 * OPE-200 — /api/internal/harvest-fetch. Internal-key gated; SSRF-guarded;
 * fetches a sitemap (→ <loc> URLs) or an HTML page (→ JSON-LD Events) server-
 * side, escalating to Browser Rendering on a WAF-block. Only global `fetch` is
 * mocked (the site-fetch package + html-parser run for real).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => ({}),
  getCloudflareEnv: () => ({
    INTERNAL_API_KEY: "test-key",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    CLOUDFLARE_BROWSER_RENDERING_TOKEN: "br-token",
    // no RATE_LIMIT_KV → rate-limit block is skipped (fail-open)
  }),
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => {}) }));

import { POST } from "../route";

const ctx = { params: Promise.resolve({}) };
function req(body: unknown, withKey = true): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (withKey) headers["x-internal-key"] = "test-key";
  return new NextRequest("http://localhost/api/internal/harvest-fetch", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

let originalFetch: typeof globalThis.fetch;
/** Route target through `respond(url)`; the CF Browser-Rendering API returns `brHtml`. */
function mockFetch(respond: (url: string) => Response, brHtml?: string) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("browser-rendering/content")) {
      return new Response(JSON.stringify({ success: true, result: brHtml ?? "" }), { status: 200 });
    }
    return respond(url);
  }) as typeof fetch;
}
afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});
beforeEach(() => {
  originalFetch = undefined as unknown as typeof globalThis.fetch;
});

const SITEMAP = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://visitrhodeisland.com/event/a/</loc></url><url><loc>https://visitrhodeisland.com/event/b/</loc></url></urlset>`;
const EVENT_HTML = `<!doctype html><html><head><title>Summer Fair</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"Event","name":"Summer Fair","startDate":"2027-06-01"}</script></head><body>x</body></html>`;

describe("POST /api/internal/harvest-fetch (OPE-200)", () => {
  it("401 without the internal key", async () => {
    const res = await POST(req({ url: "https://visitrhodeisland.com/sitemap.xml" }, false), ctx);
    expect(res.status).toBe(401);
  });

  it("400 on an invalid url", async () => {
    const res = await POST(req({ url: "not a url" }), ctx);
    expect(res.status).toBe(400);
  });

  it("400 forbidden_host for an SSRF target (private IP)", async () => {
    const res = await POST(req({ url: "http://127.0.0.1/admin" }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("forbidden_host");
  });

  it("fetches a sitemap → <loc> URLs (kind=sitemap, standard path)", async () => {
    mockFetch(
      () => new Response(SITEMAP, { status: 200, headers: { "content-type": "application/xml" } })
    );
    const res = await POST(req({ url: "https://visitrhodeisland.com/sitemap.xml" }), ctx);
    const j = (await res.json()) as {
      success: boolean;
      kind: string;
      sitemapUrls: string[];
      fetchMethod: string;
    };
    expect(j.success).toBe(true);
    expect(j.kind).toBe("sitemap");
    expect(j.fetchMethod).toBe("standard");
    expect(j.sitemapUrls).toEqual([
      "https://visitrhodeisland.com/event/a/",
      "https://visitrhodeisland.com/event/b/",
    ]);
  });

  it("fetches an HTML page → JSON-LD Events (kind=page)", async () => {
    mockFetch(
      () => new Response(EVENT_HTML, { status: 200, headers: { "content-type": "text/html" } })
    );
    const res = await POST(req({ url: "https://mainetourism.com/events/summer-fair" }), ctx);
    const j = (await res.json()) as { kind: string; jsonLdEvents: Array<{ name?: string }> };
    expect(j.kind).toBe("page");
    expect(j.jsonLdEvents.length).toBe(1);
    expect(j.jsonLdEvents[0].name).toBe("Summer Fair");
  });

  it("escalates to Browser Rendering on a 403 WAF-block", async () => {
    mockFetch(
      () => new Response("blocked", { status: 403 }),
      EVENT_HTML // Browser Rendering returns the rendered HTML
    );
    const res = await POST(req({ url: "https://visitwhitemountains.com/events" }), ctx);
    const j = (await res.json()) as {
      success: boolean;
      fetchMethod: string;
      jsonLdEvents: unknown[];
    };
    expect(j.success).toBe(true);
    expect(j.fetchMethod).toBe("browser-rendering");
    expect(j.jsonLdEvents.length).toBe(1);
  });

  it("returns fetch_failed when both paths fail (404, no escalation)", async () => {
    mockFetch(() => new Response("nope", { status: 404 }));
    const res = await POST(req({ url: "https://mainetourism.com/gone" }), ctx);
    const j = (await res.json()) as { success: boolean; fetchMethod: string };
    expect(j.success).toBe(false);
    expect(j.fetchMethod).toBe("failed");
  });
});
