/**
 * OPE-424 — HTTPS first, HTTP as a marked fallback (John's ruling 2026-09-30).
 *
 * Measured 2026-09-30 on organizer hosts whose source URL is `http://`:
 * islandartsassociation.com (self-signed cert), stpetersfiesta.org (handshake
 * failure) and pokekon.com (connection refused) fail fast on :443;
 * winchestergrange.org HANGS there. Every one serves the page over plain HTTP.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchStandard } from "./browser-rendering";

// `Response.url` is a read-only getter, so it is defined rather than assigned.
const page = (url: string) =>
  Object.defineProperty(
    new Response("<html><body>Holiday Craft Fair, 9 to 4 all three days</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
    "url",
    { value: url }
  );

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const spy = vi.fn(handler);
  vi.stubGlobal("fetch", spy);
  return spy;
}

const signal = () => new AbortController().signal;

afterEach(() => vi.unstubAllGlobals());

describe("fetchStandard — transport policy", () => {
  it("an https:// URL is fetched as given and stamped https", async () => {
    const f = mockFetch(async (u) => page(u));
    const r = await fetchStandard("https://example.org/fair", signal());
    expect(r).toMatchObject({ ok: true, transport: "https" });
    expect(f.mock.calls.map((c) => c[0])).toEqual(["https://example.org/fair"]);
  });

  it("an https:// URL that fails is NEVER downgraded to http", async () => {
    const f = mockFetch(async () => {
      throw new TypeError("self-signed certificate");
    });
    const r = await fetchStandard("https://example.org/fair", signal());
    expect(r.ok).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("an http:// URL is tried over HTTPS first, and uses it when it works", async () => {
    const f = mockFetch(async (u) => page(u));
    const r = await fetchStandard("http://nhfestivals.org/", signal());
    expect(r).toMatchObject({ ok: true, transport: "https" });
    expect(f.mock.calls.map((c) => c[0])).toEqual(["https://nhfestivals.org/"]);
  });

  it("falls back to HTTP on a TLS failure, and marks the result http (the Island Arts shape)", async () => {
    const f = mockFetch(async (u) => {
      if (u.startsWith("https:")) throw new TypeError("self-signed certificate");
      return page(u);
    });
    const r = await fetchStandard("http://www.islandartsassociation.com/upcoming-fairs/", signal());
    expect(r).toMatchObject({ ok: true, transport: "http" });
    if (r.ok) expect(r.html).toContain("9 to 4");
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      "https://www.islandartsassociation.com/upcoming-fairs/",
      "http://www.islandartsassociation.com/upcoming-fairs/",
    ]);
  });

  it("a HANGING :443 hits the per-attempt cap and still falls back (the Winchester Grange shape)", async () => {
    mockFetch((u, init) => {
      if (u.startsWith("http:")) return Promise.resolve(page(u));
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        );
      });
    });
    const r = await fetchStandard("http://winchestergrange.org/", signal(), {
      httpsAttemptMs: 20,
    });
    expect(r).toMatchObject({ ok: true, transport: "http" });
  });

  it("an HTTP-level answer over HTTPS is the site's real answer — no fallback", async () => {
    const f = mockFetch(async () => new Response("gone", { status: 404 }));
    const r = await fetchStandard("http://example.org/old", signal());
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("the CALLER's deadline is a plain timeout and is not retried over HTTP", async () => {
    const ctl = new AbortController();
    const f = mockFetch(
      (_u, init) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          );
          setTimeout(() => ctl.abort(), 5);
        })
    );
    const r = await fetchStandard("http://example.org/", ctl.signal, { httpsAttemptMs: 10_000 });
    expect(r).toMatchObject({ ok: false, error: "timeout" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("an http:// fetch that redirects onto https was a TLS fetch after all", async () => {
    mockFetch(async (u) => {
      if (u.startsWith("https:")) throw new TypeError("handshake failure");
      return page("https://www.example.org/");
    });
    const r = await fetchStandard("http://example.org/", signal());
    expect(r).toMatchObject({ ok: true, transport: "https" });
  });
});
