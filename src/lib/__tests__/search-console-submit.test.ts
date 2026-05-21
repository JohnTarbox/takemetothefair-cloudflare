import { afterEach, describe, expect, it, vi } from "vitest";

// Bypass the JWT signer — tests focus on submitSitemap's request shape,
// validation, and error handling, NOT on the OAuth flow itself (which is
// covered by integration tests against real Google).
vi.mock("@/lib/google-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google-auth")>("@/lib/google-auth");
  return {
    ...actual,
    getGoogleAccessToken: vi.fn(async () => "fake-token"),
  };
});

import {
  ScApiError,
  ScConfigError,
  submitSitemap,
  validateSitemapBelongsToProperty,
} from "@/lib/search-console";

describe("validateSitemapBelongsToProperty", () => {
  describe("URL-prefix properties", () => {
    const siteUrl = "https://meetmeatthefair.com/";

    it("accepts exact-host sitemap URLs", () => {
      expect(() =>
        validateSitemapBelongsToProperty(siteUrl, "https://meetmeatthefair.com/sitemap.xml")
      ).not.toThrow();
    });

    it("is case-insensitive on the host", () => {
      expect(() =>
        validateSitemapBelongsToProperty(siteUrl, "https://MEETMEATTHEFAIR.com/sitemap.xml")
      ).not.toThrow();
    });

    it("rejects off-property hosts", () => {
      expect(() =>
        validateSitemapBelongsToProperty(siteUrl, "https://example.com/sitemap.xml")
      ).toThrow(ScConfigError);
    });

    it("rejects subdomain hosts (URL-prefix is exact-host only)", () => {
      expect(() =>
        validateSitemapBelongsToProperty(siteUrl, "https://www.meetmeatthefair.com/sitemap.xml")
      ).toThrow(ScConfigError);
    });
  });

  describe("sc-domain: properties", () => {
    const siteUrl = "sc-domain:meetmeatthefair.com";

    it("accepts apex-host sitemap URLs", () => {
      expect(() =>
        validateSitemapBelongsToProperty(siteUrl, "https://meetmeatthefair.com/sitemap.xml")
      ).not.toThrow();
    });

    it("accepts subdomain hosts (sc-domain covers the whole domain)", () => {
      expect(() =>
        validateSitemapBelongsToProperty(siteUrl, "https://www.meetmeatthefair.com/sitemap.xml")
      ).not.toThrow();
      expect(() =>
        validateSitemapBelongsToProperty(siteUrl, "https://cdn.meetmeatthefair.com/sitemap.xml")
      ).not.toThrow();
    });

    it("rejects look-alike hosts (suffix-only match attack)", () => {
      // 'notmeetmeatthefair.com' ends with 'meetmeatthefair.com' as a
      // substring but isn't a subdomain. The `.` separator check prevents
      // accepting it.
      expect(() =>
        validateSitemapBelongsToProperty(siteUrl, "https://notmeetmeatthefair.com/sitemap.xml")
      ).toThrow(ScConfigError);
    });
  });

  it("rejects an invalid sitemap URL with a clear message", () => {
    expect(() => validateSitemapBelongsToProperty("https://x.com/", "not-a-url")).toThrow(
      /Invalid sitemap URL/
    );
  });
});

describe("submitSitemap", () => {
  const env = {
    GA4_SA_CLIENT_EMAIL: "sa@test.iam.gserviceaccount.com",
    GA4_SA_PRIVATE_KEY: "fake",
    SC_SITE_URL: "https://meetmeatthefair.com/",
  };

  // OAuth path is mocked at the module boundary via vi.mock above. Each
  // test stubs `fetch` for the GSC call only.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an off-property sitemap URL BEFORE making any network call", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return new Response("", { status: 200 });
      })
    );
    await expect(submitSitemap(env, "https://example.com/sitemap.xml")).rejects.toBeInstanceOf(
      ScConfigError
    );
    expect(calls).toBe(0);
  });

  it("calls PUT with the URL-encoded property + feedpath path segments", async () => {
    const calls: { url: string; method?: string; headers?: HeadersInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push({ url, method: init?.method, headers: init?.headers });
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), {
            status: 200,
          });
        }
        return new Response("", { status: 200 });
      })
    );

    const result = await submitSitemap(env, "https://meetmeatthefair.com/sitemap-events.xml");

    const gscCall = calls.find((c) => c.url.includes("searchconsole.googleapis.com"));
    expect(gscCall).toBeDefined();
    expect(gscCall!.method).toBe("PUT");
    // Both site and sitemap URL must be fully URL-encoded path segments
    // (each `/` becomes `%2F`, `:` becomes `%3A`).
    expect(gscCall!.url).toContain(encodeURIComponent("https://meetmeatthefair.com/"));
    expect(gscCall!.url).toContain(
      encodeURIComponent("https://meetmeatthefair.com/sitemap-events.xml")
    );
    expect(result.feedpath).toBe("https://meetmeatthefair.com/sitemap-events.xml");
    expect(result.siteUrl).toBe("https://meetmeatthefair.com/");
    expect(typeof result.submittedAt).toBe("string");
  });

  it("throws ScApiError with status + parsed message on GSC error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({
            error: { status: "PERMISSION_DENIED", message: "User does not have permission." },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    await expect(
      submitSitemap(env, "https://meetmeatthefair.com/sitemap.xml")
    ).rejects.toMatchObject({
      name: "ScApiError",
      status: 403,
      detail: expect.stringContaining("PERMISSION_DENIED"),
    });
  });

  it("throws ScApiError with raw text when GSC returns non-JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), {
            status: 200,
          });
        }
        return new Response("<html>internal error</html>", { status: 500 });
      })
    );

    await expect(
      submitSitemap(env, "https://meetmeatthefair.com/sitemap.xml")
    ).rejects.toBeInstanceOf(ScApiError);
  });
});
