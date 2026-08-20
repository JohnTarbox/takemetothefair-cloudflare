/**
 * OPE-237 — `fetchHtmlWithSsrfGuard`.
 *
 * This helper exists because the corroboration pass fetches a URL supplied by
 * an UNVERIFIED PUBLIC REGISTRANT. `fetchStandard` deliberately does not guard
 * — its callers pass operator-typed or self-owned URLs — so using it there
 * would have been a stored SSRF with an admin action as the trigger.
 *
 * The redirect cases are the ones worth the most: a single up-front host check
 * is the obvious implementation and it is defeated by a public host that 3xx's
 * into an internal one.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchHtmlWithSsrfGuard } from "./browser-rendering";

const signal = new AbortController().signal;

afterEach(() => vi.unstubAllGlobals());

function stubFetch(impl: (url: string) => Response) {
  const spy = vi.fn((input: RequestInfo | URL) => Promise.resolve(impl(String(input))));
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("blocks internal hosts up front", () => {
  const BLOCKED = [
    "http://localhost/x",
    "http://127.0.0.1/x",
    "http://169.254.169.254/latest/meta-data/", // cloud metadata
    "http://10.0.0.5/x",
    "http://192.168.1.1/x",
    "http://172.16.0.1/x",
    "http://[::1]/x",
    "http://something.internal/x",
  ];

  for (const url of BLOCKED) {
    it(`refuses ${url}`, async () => {
      const spy = stubFetch(() => new Response("should never be requested"));
      const out = await fetchHtmlWithSsrfGuard(url, signal);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toBe("blocked_host");
      // The load-bearing assertion: no request was ever issued.
      expect(spy).not.toHaveBeenCalled();
    });
  }

  it("refuses a non-http(s) scheme without fetching", async () => {
    const spy = stubFetch(() => new Response(""));
    const out = await fetchHtmlWithSsrfGuard("file:///etc/passwd", signal);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe("blocked_protocol");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("re-checks every redirect hop", () => {
  it("blocks a PUBLIC host that redirects to cloud metadata", async () => {
    // The case a single up-front check misses entirely.
    const spy = stubFetch((url) =>
      url.startsWith("https://evil.example.com")
        ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/x" } })
        : new Response("<html>secret</html>")
    );

    const out = await fetchHtmlWithSsrfGuard("https://evil.example.com/", signal);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe("blocked_host");
    // The first hop was fetched; the internal second hop was NOT.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls.every(([u]) => !String(u).includes("169.254"))).toBe(true);
  });

  it("blocks a relative redirect that lands on an internal host", async () => {
    const spy = stubFetch((url) =>
      url === "https://ok.example.com/a"
        ? new Response(null, { status: 301, headers: { location: "http://127.0.0.1/b" } })
        : new Response("<html>x</html>")
    );
    const out = await fetchHtmlWithSsrfGuard("https://ok.example.com/a", signal);
    expect(out.ok).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("caps redirect depth rather than looping", async () => {
    const spy = stubFetch(
      () => new Response(null, { status: 302, headers: { location: "https://a.example.com/next" } })
    );
    const out = await fetchHtmlWithSsrfGuard("https://a.example.com/", signal, 2);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe("too_many_redirects");
    expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe("still fetches ordinary public sites", () => {
  it("returns HTML and the final URL", async () => {
    stubFetch(() => new Response("<html>Fryeburg Fair</html>", { status: 200 }));
    const out = await fetchHtmlWithSsrfGuard("https://fryeburgfair.org/", signal);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.html).toContain("Fryeburg Fair");
      expect(out.finalUrl).toBe("https://fryeburgfair.org/");
    }
  });

  it("follows a public → public redirect and reports the final URL", async () => {
    stubFetch((url) =>
      url === "https://old.example.com/"
        ? new Response(null, { status: 301, headers: { location: "https://new.example.com/" } })
        : new Response("<html>moved</html>", { status: 200 })
    );
    const out = await fetchHtmlWithSsrfGuard("https://old.example.com/", signal);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.finalUrl).toBe("https://new.example.com/");
  });

  it("reports a 404 as a failure, not a throw", async () => {
    stubFetch(() => new Response("nope", { status: 404 }));
    const out = await fetchHtmlWithSsrfGuard("https://gone.example.com/", signal);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe("http_404");
  });
});
