/**
 * OPE-1370 (SSRF5) — the vendor-site fetch checked the first hop only, then
 * the standard path followed 3xx unchecked. Now every hop is re-checked, and a
 * refused hop is never escalated to Browser Rendering.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchVendorSite } from "../src/enrichment/fetch-site.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ENV = { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_BROWSER_RENDERING_TOKEN: "tok" };
const PAGE = "<html><body>Maple syrup, maple candy, maple cream since 1952</body></html>";

describe("fetchVendorSite (OPE-1370)", () => {
  it("refuses a vendor site that redirects to localhost., and does not escalate it", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("browser-rendering")) {
        return Response.json({ success: true, result: PAGE });
      }
      if (url === "https://sugarhouse.example.com/" && init?.redirect === "manual") {
        return new Response(null, { status: 301, headers: { location: "http://localhost./" } });
      }
      return new Response(PAGE, { headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;

    const r = await fetchVendorSite("https://sugarhouse.example.com/", ENV);
    expect(r).toMatchObject({ ok: false, html: null, fetchMethod: "failed" });
    expect(r.failReason).toBe("blocked_host");
    expect(seen).toEqual(["https://sugarhouse.example.com/"]);
  });

  it("still fetches an ordinary vendor site", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(PAGE, { headers: { "content-type": "text/html" } })
    ) as unknown as typeof fetch;
    const r = await fetchVendorSite("https://sugarhouse.example.com/", ENV);
    expect(r).toMatchObject({ ok: true, fetchMethod: "standard" });
  });
});
