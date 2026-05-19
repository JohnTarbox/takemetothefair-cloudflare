/**
 * Tests for A5 Browser Rendering escalation in the URL-fetch route.
 *
 * Focus: the escalation decision tree. Each test mocks global fetch to
 * return a specific sequence (standard-path response → optional Browser
 * Rendering response) and asserts the route's `fetchMethod` field and
 * success/failure shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: vi.fn(() => null),
  getCloudflareEnv: vi.fn(() => ({
    INTERNAL_API_KEY: "test-internal-key",
    CLOUDFLARE_ACCOUNT_ID: "test-account",
    CLOUDFLARE_BROWSER_RENDERING_TOKEN: "test-token",
  })),
}));

vi.mock("@/lib/logger", () => ({
  logError: vi.fn(),
}));

vi.mock("@/lib/url-import/html-parser", () => ({
  extractMetadata: vi.fn(() => ({
    title: "Test Page",
    description: null,
    ogImage: null,
    jsonLd: null,
  })),
  extractTextFromHtml: vi.fn(() => "extracted content"),
}));

import { GET } from "../route";

function makeRequest(url: string): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/admin/import-url/fetch?url=${encodeURIComponent(url)}`,
    {
      headers: { "x-internal-key": "test-internal-key" },
    }
  );
}

describe("GET /api/admin/import-url/fetch — Browser Rendering escalation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns fetchMethod='standard' when initial fetch succeeds", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response("<html><body>ok</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
    );

    const res = await GET(makeRequest("https://example.com/ok"));
    const body = (await res.json()) as {
      success: boolean;
      fetchMethod?: string;
      error?: string;
    };

    expect(body.success).toBe(true);
    expect(body.fetchMethod).toBe("standard");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("escalates to Browser Rendering on 403 and returns fetchMethod='browser-rendering'", async () => {
    let callCount = 0;
    global.fetch = vi.fn(async (input: Request | URL | string) => {
      callCount += 1;
      const urlStr =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (callCount === 1) {
        // Standard fetch — origin WAF returns 403.
        expect(urlStr).toBe("https://example.com/blocked");
        return new Response("forbidden", { status: 403 });
      }
      // Browser Rendering call — should hit api.cloudflare.com.
      expect(urlStr).toContain("api.cloudflare.com");
      expect(urlStr).toContain("/browser-rendering/content");
      return new Response(
        JSON.stringify({ success: true, result: "<html><body>rendered</body></html>" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const res = await GET(makeRequest("https://example.com/blocked"));
    const body = (await res.json()) as {
      success: boolean;
      fetchMethod?: string;
      error?: string;
    };

    expect(body.success).toBe(true);
    expect(body.fetchMethod).toBe("browser-rendering");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("escalates on 429 (rate-limited)", async () => {
    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) return new Response("too many", { status: 429 });
      return new Response(JSON.stringify({ success: true, result: "<html></html>" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const res = await GET(makeRequest("https://example.com/throttled"));
    const body = (await res.json()) as {
      success: boolean;
      fetchMethod?: string;
      error?: string;
    };

    expect(body.success).toBe(true);
    expect(body.fetchMethod).toBe("browser-rendering");
  });

  it("does NOT escalate on 404 — surfaces fetchMethod='failed'", async () => {
    global.fetch = vi.fn(async () => new Response("not found", { status: 404 }));

    const res = await GET(makeRequest("https://example.com/gone"));
    const body = (await res.json()) as {
      success: boolean;
      fetchMethod?: string;
      error?: string;
    };

    expect(body.success).toBe(false);
    expect(body.fetchMethod).toBe("failed");
    expect(body.error).toContain("404");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns fetchMethod='failed' when both paths fail", async () => {
    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) return new Response("blocked", { status: 403 });
      return new Response("server error", { status: 500 });
    });

    const res = await GET(makeRequest("https://example.com/hard-block"));
    const body = (await res.json()) as {
      success: boolean;
      fetchMethod?: string;
      error?: string;
    };

    expect(body.success).toBe(false);
    expect(body.fetchMethod).toBe("failed");
    expect(body.error).toContain("403");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("returns fetchMethod='failed' when Browser Rendering envelope is malformed", async () => {
    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) return new Response("blocked", { status: 403 });
      // Browser Rendering returns success=false envelope.
      return new Response(
        JSON.stringify({ success: false, errors: [{ message: "browser unavailable" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const res = await GET(makeRequest("https://example.com/br-fail"));
    const body = (await res.json()) as {
      success: boolean;
      fetchMethod?: string;
      error?: string;
    };

    expect(body.success).toBe(false);
    expect(body.fetchMethod).toBe("failed");
  });
});
