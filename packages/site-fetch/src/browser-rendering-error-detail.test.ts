/**
 * OPE-537 follow-up — the Browser Rendering 422, and why it took five weeks
 * to become a question anyone could answer.
 *
 * Prod evidence (D1, 2026-08-24):
 *   - `inbound_emails.fetch_method='browser-rendering'` — 6 rows, last
 *     2026-07-19 14:36. Browser Rendering has not succeeded since.
 *   - `error_logs` — every attempt after that date recorded exactly
 *     `browser-rendering-http-422`, and nothing else.
 *
 * The request body (`JSON.stringify({ url })`) had not changed since PR #478,
 * so the regression was upstream. But the code discarded the response body on
 * `!response.ok`, so "422" was the entire diagnosis available. Cloudflare
 * returns `{ success, errors: [{ code, message }] }` there — we were throwing
 * away the sentence that explains the number.
 *
 * Two behaviours are pinned here:
 *   1. the upstream error text survives into `error`
 *   2. explicit `gotoOptions` are SENT (Cloudflare's documented remedy for 422)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchViaBrowserRendering,
  BROWSER_RENDERING_GOTO,
  BROWSER_RENDERING_TIMEOUT,
  API_ERROR_DETAIL_CAP,
} from "./browser-rendering";

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: "acct-123",
  CLOUDFLARE_BROWSER_RENDERING_TOKEN: "tok-456",
};

/** Capture the outbound request so the body can be asserted on. */
function mockApi(response: Response): { body: () => Record<string, unknown> } {
  const calls: RequestInit[] = [];
  global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls.push(init ?? {});
    return response;
  }) as unknown as typeof fetch;
  return {
    body: () => JSON.parse(String(calls[0]?.body ?? "{}")) as Record<string, unknown>,
  };
}

const jsonResponse = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("fetchViaBrowserRendering — upstream error detail", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("keeps the Cloudflare error message on a 422 instead of discarding it", async () => {
    mockApi(
      jsonResponse(422, {
        success: false,
        errors: [{ code: 2001, message: "Navigation timeout of 30000 ms exceeded" }],
      })
    );

    const out = await fetchViaBrowserRendering("https://example.com/slow", ENV);

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    // The prefix stays — log greps and dashboards match on it.
    expect(out.error).toContain("browser-rendering-http-422");
    // ...and the part that was missing for five weeks is now there.
    expect(out.error).toContain("Navigation timeout");
    expect(out.error).toContain("2001");
  });

  it("falls back to the raw body when the error is not JSON", async () => {
    mockApi(new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 }));

    const out = await fetchViaBrowserRendering("https://example.com/x", ENV);

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.error).toContain("browser-rendering-http-502");
    expect(out.error).toContain("502 Bad Gateway");
  });

  it("caps the captured detail so an HTML error page cannot flood the log column", async () => {
    mockApi(new Response("x".repeat(5000), { status: 500 }));

    const out = await fetchViaBrowserRendering("https://example.com/x", ENV);

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    const detail = out.error.replace("browser-rendering-http-500: ", "");
    expect(detail.length).toBeLessThanOrEqual(API_ERROR_DETAIL_CAP);
  });

  it("still fails cleanly when the error body cannot be read at all", async () => {
    // A body that throws on read must not turn an upstream 422 into a
    // *parse* error — this path is already failing; it must stay legible.
    const broken = new Response(null, { status: 422 });
    Object.defineProperty(broken, "text", {
      value: () => Promise.reject(new Error("stream already consumed")),
    });
    mockApi(broken);

    const out = await fetchViaBrowserRendering("https://example.com/x", ENV);

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.error).toContain("browser-rendering-http-422");
  });
});

describe("fetchViaBrowserRendering — gotoOptions", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("SENDS explicit gotoOptions — the documented remedy for the 422", async () => {
    const api = mockApi(jsonResponse(200, { success: true, result: "<html>ok</html>" }));

    await fetchViaBrowserRendering("https://example.com/ok", ENV);

    const body = api.body();
    expect(body.url).toBe("https://example.com/ok");
    // Asserting the VALUE, not merely presence: an empty object would be
    // indistinguishable from the default behaviour that was 422ing.
    expect(body.gotoOptions).toEqual({
      waitUntil: "networkidle2",
      timeout: 20000,
    });
  });

  it("waits for network idle, not DOMContentLoaded", async () => {
    // These pages reach Browser Rendering precisely because their content is
    // JS-rendered. Returning at DOMContentLoaded would hand back the same
    // empty shell the standard fetch already got — a silent regression that
    // would look like "Browser Rendering works now" while extracting nothing.
    expect(BROWSER_RENDERING_GOTO.waitUntil).toBe("networkidle2");
  });

  it("gives the API time to answer before our own abort fires", async () => {
    // If our AbortController wins the race we kill the request before
    // Cloudflare can tell us why it failed — which is the exact blindness
    // the error-detail capture above exists to remove. Ordering is the
    // invariant; the specific numbers may change.
    expect(BROWSER_RENDERING_GOTO.timeout).toBeLessThan(BROWSER_RENDERING_TIMEOUT);
  });
});
