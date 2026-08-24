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
  // OPE-537 — the stub's LENGTH is now load-bearing.
  //
  // This returned "extracted content" (17 chars). The route now treats a 200
  // whose extracted text is essentially empty as a FAILED fetch, because
  // returning `success: true` with an empty string is what handed /extract an
  // empty payload and got a 400 back several services later. A 17-character
  // stub sits below that bar and made three routing tests fail for a reason
  // that had nothing to do with routing.
  //
  // Long enough to represent a real page, which is what the stub always meant.
  extractTextFromHtml: vi.fn(
    () =>
      "Kingfield Craft Fair — Saturday October 4, 2026, 9am to 4pm at the " +
      "Kingfield Elementary School gym. Over 40 local makers, free admission."
  ),
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

// The route now exports a withAuthorized-wrapped handler whose Next-15 typed
// signature requires the second (context) argument. This static route has no
// dynamic params, so params resolves to {}.
const noParams = { params: Promise.resolve({} as Record<string, never>) };

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

    const res = await GET(makeRequest("https://example.com/ok"), noParams);
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

    const res = await GET(makeRequest("https://example.com/blocked"), noParams);
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

    const res = await GET(makeRequest("https://example.com/throttled"), noParams);
    const body = (await res.json()) as {
      success: boolean;
      fetchMethod?: string;
      error?: string;
    };

    expect(body.success).toBe(true);
    expect(body.fetchMethod).toBe("browser-rendering");
  });

  it("OPE-537: a 200 with no readable text escalates to Browser Rendering", async () => {
    // The case that got past everything: the status was fine, so shouldEscalate
    // said no, and an empty string was returned as `success: true`.
    const { extractTextFromHtml } = await import("@/lib/url-import/html-parser");
    vi.mocked(extractTextFromHtml)
      .mockReturnValueOnce("") // standard fetch — unreadable page
      .mockReturnValue(
        "Vermont Crafters Expo — November 7 and 8, 2026 at the Champlain Valley Expo."
      );

    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response("<html><body><div id=app></div></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(
        JSON.stringify({ success: true, result: "<html><body>rendered</body></html>" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const res = await GET(makeRequest("https://example.com/js-only"), noParams);
    const body = (await res.json()) as { success: boolean; fetchMethod?: string };

    expect(body.success).toBe(true);
    expect(body.fetchMethod).toBe("browser-rendering");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("OPE-537: fails with a NAMED reason when the rendered page is also empty", async () => {
    // The honest-bounce case. It must not return `success: true` with "" and
    // let a downstream validator invent a different explanation.
    const { extractTextFromHtml } = await import("@/lib/url-import/html-parser");
    vi.mocked(extractTextFromHtml).mockReturnValue("");

    global.fetch = vi.fn(
      async () =>
        new Response("<html><body></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
    );

    const res = await GET(makeRequest("https://example.com/empty"), noParams);
    const body = (await res.json()) as { success: boolean; error?: string; fetchMethod?: string };

    expect(body.success).toBe(false);
    expect(body.fetchMethod).toBe("failed");
    expect(body.error).toMatch(/no readable text/i);
  });

  it("OPE-537: logs a SAMPLE of the body, not just its length", async () => {
    // The Vermont Crafters Expo re-submit (`f2b62b40`, 2026-08-24) logged
    // `htmlBytes: 219` — a 200 carrying 219 bytes, while the same URL served
    // 86,036 bytes to a request from outside Cloudflare with byte-identical
    // headers. A WAF stub, a meta-refresh, a JS challenge and an empty CMS
    // shell are all plausible at that size and indistinguishable by length,
    // so the diagnosis stalled on a number.
    const { extractTextFromHtml } = await import("@/lib/url-import/html-parser");
    vi.mocked(extractTextFromHtml).mockReturnValue("");
    const { logError } = await import("@/lib/logger");

    const stub = '<html><head><meta http-equiv="refresh" content="0;url=/blocked"></head></html>';
    global.fetch = vi.fn(
      async () => new Response(stub, { status: 200, headers: { "content-type": "text/html" } })
    );

    await GET(makeRequest("https://example.com/stub"), noParams);

    expect(logError).toHaveBeenCalled();
    const ctx = vi.mocked(logError).mock.calls.at(-1)?.[1]?.context as Record<string, unknown>;
    expect(ctx.htmlBytes).toBe(stub.length);
    // The actual bytes — the part that identifies WHICH kind of stub it is.
    expect(String(ctx.htmlPrefix)).toContain("http-equiv");
    expect(String(ctx.htmlPrefix)).toContain("/blocked");
  });

  it("OPE-537: caps and single-lines the logged sample", async () => {
    const { extractTextFromHtml } = await import("@/lib/url-import/html-parser");
    vi.mocked(extractTextFromHtml).mockReturnValue("");

    const { logError } = await import("@/lib/logger");
    // Pretty-printed markup: without whitespace collapsing, indentation alone
    // would push the informative part of the page past the cap.
    const huge = "<html>\n" + "        <div>padding</div>\n".repeat(400) + "</html>";
    global.fetch = vi.fn(
      async () => new Response(huge, { status: 200, headers: { "content-type": "text/html" } })
    );

    await GET(makeRequest("https://example.com/huge"), noParams);

    const ctx = vi.mocked(logError).mock.calls.at(-1)?.[1]?.context as Record<string, unknown>;
    const prefix = String(ctx.htmlPrefix);
    expect(prefix.length).toBeLessThanOrEqual(220);
    expect(prefix).not.toContain("\n");
    expect(prefix).not.toContain("        ");
  });

  it("does NOT escalate on 404 — surfaces fetchMethod='failed'", async () => {
    global.fetch = vi.fn(async () => new Response("not found", { status: 404 }));

    const res = await GET(makeRequest("https://example.com/gone"), noParams);
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

    const res = await GET(makeRequest("https://example.com/hard-block"), noParams);
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

    const res = await GET(makeRequest("https://example.com/br-fail"), noParams);
    const body = (await res.json()) as {
      success: boolean;
      fetchMethod?: string;
      error?: string;
    };

    expect(body.success).toBe(false);
    expect(body.fetchMethod).toBe("failed");
  });

  // Analyst C2 Phase 1 (2026-05-29). PDF detection: surface a tailored
  // user message AND a distinct fetchMethod value so the workflow can
  // route to a PDF-specific email reply and the inbound_emails table
  // records the failure mode separately from generic both-paths-failed.
  // Browser Rendering escalation is suppressed because BR's /content
  // endpoint returns rendered HTML, not extracted PDF text — escalating
  // would burn billable browser-time on a path that can't recover.
  it("detects PDF by Content-Type and returns fetchMethod='pdf_unsupported'", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response("%PDF-1.4\nbinary", {
          status: 200,
          headers: { "content-type": "application/pdf" },
        })
    );

    const res = await GET(makeRequest("https://example.com/event-flyer"), noParams);
    const body = (await res.json()) as {
      success: boolean;
      fetchMethod?: string;
      error?: string;
    };

    expect(body.success).toBe(false);
    expect(body.fetchMethod).toBe("pdf_unsupported");
    expect(body.error).toMatch(/PDF/i);
    // Critical: do NOT escalate to Browser Rendering on PDF — exactly
    // one fetch call. Burning BR minutes on a path that can't recover
    // would defeat the whole point of the early-detect.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("detects PDF by .pdf URL extension when Content-Type is octet-stream", async () => {
    // Many town/rec servers return application/octet-stream for PDFs;
    // catch those too. The extension regex tolerates query strings and
    // fragments (?token=abc, #page=3).
    global.fetch = vi.fn(
      async () =>
        new Response("%PDF-1.4\nbinary", {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        })
    );

    const res = await GET(
      makeRequest("https://belgrademaine.gov/craft_fair_2026_application.pdf?download=1"),
      noParams
    );
    const body = (await res.json()) as {
      success: boolean;
      fetchMethod?: string;
      error?: string;
    };

    expect(body.success).toBe(false);
    expect(body.fetchMethod).toBe("pdf_unsupported");
    expect(body.error).toMatch(/PDF/i);
  });
});
