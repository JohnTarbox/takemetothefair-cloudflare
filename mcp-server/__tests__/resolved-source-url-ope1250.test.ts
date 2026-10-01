/**
 * OPE-1250 — events and citations built from a share.google link stored the
 * opaque short link as source_url. submitFetch now adopts the post-redirect URL
 * the main app reports, but only across a HOST change, so same-host redirects
 * keep the form existing dedup keys were stored in.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { adoptFinalUrl, submitFetch, submitExtract } from "../src/email-handlers/submit.js";

const SHORT = "https://share.google/dep4eDy9xPosZHWTH";
const ARTICLE = "https://wgme.com/news/local/cumberland-fair-returns";
const env = { MAIN_APP_URL: "https://app.test", INTERNAL_API_KEY: "k" } as never;

afterEach(() => vi.unstubAllGlobals());

describe("adoptFinalUrl", () => {
  it("adopts a cross-host redirect (share link → article)", () => {
    expect(adoptFinalUrl(SHORT, ARTICLE)).toBe(ARTICLE);
  });
  it("keeps the requested URL for same-host redirects", () => {
    expect(adoptFinalUrl("http://cumberlandfair.com/", "https://cumberlandfair.com/")).toBe(
      "http://cumberlandfair.com/"
    );
    expect(adoptFinalUrl("https://cumberlandfair.com", "https://www.cumberlandfair.com/")).toBe(
      "https://cumberlandfair.com"
    );
  });
  it("keeps the requested URL when there is no or no usable final URL", () => {
    expect(adoptFinalUrl(SHORT, undefined)).toBe(SHORT);
    expect(adoptFinalUrl(SHORT, "not a url")).toBe(SHORT);
    expect(adoptFinalUrl(SHORT, "javascript:alert(1)")).toBe(SHORT);
  });
});

describe("submitFetch → submitExtract carry the article URL", () => {
  it("fetched.url and extracted.url are the article; the short link is kept as requestedUrl", async () => {
    let extractUrl: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = new URL(String(input));
        if (u.pathname === "/api/admin/import-url/fetch") {
          return Response.json({
            success: true,
            content: "Cumberland Fair returns…",
            title: "t",
            finalUrl: ARTICLE,
          });
        }
        extractUrl = JSON.parse(String(init?.body)).url;
        return Response.json({
          success: true,
          events: [{ name: "Cumberland Fair" }],
          count: 1,
          extractionMethod: "ai",
        });
      })
    );
    const fetched = await submitFetch(env, SHORT);
    expect(fetched.url).toBe(ARTICLE);
    expect(fetched.requestedUrl).toBe(SHORT);
    const extracted = await submitExtract(env, fetched, "");
    // extracted.url is what becomes events.source_url, the citation URL, and
    // the exact_url dedup key.
    expect(extracted.url).toBe(ARTICLE);
    expect(extractUrl).toBe(ARTICLE);
  });

  it("control: an older main app with no finalUrl keeps the requested URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: true, content: "x", title: "t" }))
    );
    const fetched = await submitFetch(env, SHORT);
    expect(fetched.url).toBe(SHORT);
    expect(fetched.requestedUrl).toBeUndefined();
  });
});
