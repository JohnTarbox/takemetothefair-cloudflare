/**
 * OPE-1370 (SSRF6) — the og:image sweep fetchers and the schema.org fetcher
 * had no per-hop guard (og-image: no guard at all; schema-org: an ad-hoc
 * first-hop validator) and read bodies whole. Each now goes through
 * `guardedFetch`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptCandidateImage, fetchPageHtml } from "@/lib/og-image";
import { fetchSchemaOrg } from "@/lib/schema-org/fetcher";

afterEach(() => vi.unstubAllGlobals());

/**
 * Behaves like a real runtime: unless the caller asks for `redirect: "manual"`,
 * a 3xx is FOLLOWED (that is what made an unguarded fetcher reach the hop).
 */
function stubFetch(impl: (url: string, init?: RequestInit) => Response) {
  const seen: string[] = [];
  const run = async (url: string, init?: RequestInit): Promise<Response> => {
    seen.push(url);
    const res = impl(url, init);
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc && init?.redirect !== "manual") {
      return run(new URL(loc, url).href, init);
    }
    return res;
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => run(String(input), init))
  );
  return seen;
}

const to = (location: string) => new Response(null, { status: 302, headers: { location } });

describe("og-image fetchers", () => {
  it("acceptCandidateImage refuses an image URL that redirects to loopback", async () => {
    const seen = stubFetch((u) =>
      u === "https://cdn.example.org/hero.jpg"
        ? to("http://[::7f00:1]/hero.jpg")
        : new Response(null, {
            status: 200,
            headers: { "content-type": "image/jpeg", "content-length": "200000" },
          })
    );
    const r = await acceptCandidateImage("https://cdn.example.org/hero.jpg");
    expect(r).toMatchObject({ ok: false, reason: "fetch_failed" });
    expect(seen).toEqual(["https://cdn.example.org/hero.jpg"]);
  });

  it("fetchPageHtml refuses a page that redirects to localhost.", async () => {
    const seen = stubFetch((u) =>
      u === "https://fair.example.org/"
        ? to("http://localhost./")
        : new Response("<html>x</html>", { headers: { "content-type": "text/html" } })
    );
    expect(await fetchPageHtml("https://fair.example.org/")).toBeNull();
    expect(seen).toEqual(["https://fair.example.org/"]);
  });

  it("fetchPageHtml still returns an ordinary page", async () => {
    stubFetch(
      () =>
        new Response('<html><meta property="og:image" content="https://x/y.jpg"></html>', {
          headers: { "content-type": "text/html" },
        })
    );
    expect(await fetchPageHtml("https://fair.example.org/")).toContain("og:image");
  });
});

describe("fetchSchemaOrg", () => {
  it("refuses the old ad-hoc validator's misses without fetching", async () => {
    const seen = stubFetch(() => new Response("<html></html>"));
    for (const u of ["http://localhost./", "http://[::7f00:1]/", "http://2130706433/"]) {
      expect((await fetchSchemaOrg(u)).error).toBe("Internal URLs are not allowed");
    }
    expect(seen).toEqual([]);
  });

  it("refuses a redirect into 127.0.0.1 at hop 2", async () => {
    const seen = stubFetch((u) =>
      u === "https://tickets.example.org/e/1"
        ? to("http://127.0.0.1/")
        : new Response("<html></html>", { headers: { "content-type": "text/html" } })
    );
    expect((await fetchSchemaOrg("https://tickets.example.org/e/1")).error).toBe(
      "Internal URLs are not allowed"
    );
    expect(seen).toEqual(["https://tickets.example.org/e/1"]);
  });

  it("still parses Event JSON-LD from an ordinary page", async () => {
    stubFetch(
      () =>
        new Response(
          `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"Event","name":"Fryeburg Fair","startDate":"2027-10-01"}</script></head></html>`,
          { headers: { "content-type": "text/html" } }
        )
    );
    const r = await fetchSchemaOrg("https://fryeburgfair.example.org/");
    expect(r.error).toBeUndefined();
    expect(r.rawJsonLd).not.toBeNull();
  });
});
