/**
 * OPE-1370 — `guardedFetch`: per-hop SSRF re-validation, a streaming byte cap,
 * and a timeout that covers the body as well as the headers.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { guardedFetch, GuardedFetchError } from "./guarded-fetch";
import { fetchStandard, fetchHtmlWithSsrfGuard, shouldEscalate } from "./browser-rendering";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(impl(String(input), init))
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

const html = (body = "<html><body>Fair Saturday 9 to 4 at the grange hall</body></html>") =>
  new Response(body, { status: 200, headers: { "content-type": "text/html" } });
const redirect = (to: string, status = 302) =>
  new Response(null, { status, headers: { location: to } });

/** A body that streams `chunks` × `size` bytes with no Content-Length. */
function streamed(chunks: number, size: number, onPull?: () => void): Response {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      onPull?.();
      if (sent >= chunks) return c.close();
      sent++;
      c.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  const e = await p.then(
    () => null,
    (err) => err
  );
  expect(e).toBeInstanceOf(GuardedFetchError);
  return (e as GuardedFetchError).code;
}

describe("refuses a redirect into an internal host at hop 2", () => {
  for (const target of [
    "http://127.0.0.1/admin",
    "http://[::7f00:1]/", // IPv4-compatible loopback
    "http://localhost./", // trailing-dot loopback
    "http://169.254.169.254/latest/meta-data/",
  ]) {
    it(`public → ${target}`, async () => {
      const spy = stubFetch((u) =>
        u === "https://fair.example.org/" ? redirect(target) : html("should never be fetched")
      );
      expect(await codeOf(guardedFetch("https://fair.example.org/", { maxBytes: 1e6 }))).toBe(
        "blocked_host"
      );
      // The load-bearing assertion: the internal hop was never requested.
      expect(spy.mock.calls.map((c) => String(c[0]))).toEqual(["https://fair.example.org/"]);
      // And every request asked for manual redirects — the runtime never follows.
      expect(spy.mock.calls.every((c) => c[1]?.redirect === "manual")).toBe(true);
    });
  }

  it("refuses the internal host on the FIRST hop without fetching", async () => {
    const spy = stubFetch(() => html());
    expect(await codeOf(guardedFetch("http://[::7f00:1]/", { maxBytes: 1e6 }))).toBe(
      "blocked_host"
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a redirect onto a non-http scheme", async () => {
    stubFetch(() => redirect("file:///etc/passwd"));
    expect(await codeOf(guardedFetch("https://a.example/", { maxBytes: 1e6 }))).toBe(
      "blocked_protocol"
    );
  });

  it("caps redirect depth", async () => {
    stubFetch((u) => redirect(u + "x"));
    expect(
      await codeOf(guardedFetch("https://a.example/", { maxBytes: 1e6, maxRedirects: 2 }))
    ).toBe("too_many_redirects");
  });

  it("fetchStandard refuses the same chain and does NOT escalate it to Browser Rendering", async () => {
    stubFetch((u) =>
      u === "https://fair.example.org/" ? redirect("http://127.0.0.1/") : html("internal")
    );
    const out = await fetchStandard("https://fair.example.org/", new AbortController().signal);
    expect(out).toMatchObject({ ok: false, error: "blocked_host" });
    expect(shouldEscalate(out)).toBe(false);
  });
});

describe("byte cap", () => {
  it("aborts a streamed body as soon as it passes maxBytes", async () => {
    let pulls = 0;
    stubFetch(() => streamed(1000, 1024, () => pulls++)); // 1 MB on offer
    const res = await guardedFetch("https://big.example/", { maxBytes: 10 * 1024 });
    expect(await codeOf(res.text())).toBe("too_large");
    // Stopped near the cap, not after draining the whole megabyte.
    expect(pulls).toBeLessThan(20);
  });

  it("refuses a declared Content-Length over the cap before reading", async () => {
    stubFetch(
      () =>
        new Response("x", {
          status: 200,
          headers: { "content-type": "image/png", "content-length": String(50 * 1024 * 1024) },
        })
    );
    const res = await guardedFetch("https://big.example/x.png", { maxBytes: 10 * 1024 * 1024 });
    expect(await codeOf(res.arrayBuffer())).toBe("too_large");
  });

  it("textPrefix returns the first bytes instead of failing", async () => {
    stubFetch(() => streamed(100, 1024));
    const res = await guardedFetch("https://big.example/", { maxBytes: 4096 });
    const t = await res.textPrefix();
    expect(t.length).toBe(4096);
  });

  it("fetchHtmlWithSsrfGuard is capped too", async () => {
    stubFetch(() => streamed(8 * 1024, 1024)); // 8 MB > 5 MB cap
    const out = await fetchHtmlWithSsrfGuard("https://big.example/", new AbortController().signal);
    expect(out).toMatchObject({ ok: false, error: "too_large" });
  });

  it("fetchStandard reports an oversize page as too-large, not escalatable", async () => {
    stubFetch(() => streamed(8 * 1024, 1024));
    const out = await fetchStandard("https://big.example/", new AbortController().signal);
    expect(out).toMatchObject({ ok: false, error: "too-large" });
    expect(shouldEscalate(out)).toBe(false);
  });
});

describe("timeout covers headers AND body", () => {
  it("times out waiting for headers", async () => {
    stubFetch(
      (_u, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        })
    );
    expect(
      await codeOf(guardedFetch("https://slow.example/", { maxBytes: 1e6, timeoutMs: 20 }))
    ).toBe("timeout");
  });

  it("times out on a slow-drip body after the headers arrived", async () => {
    stubFetch((_u, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([0x61]));
          init?.signal?.addEventListener("abort", () =>
            c.error(new DOMException("aborted", "AbortError"))
          );
          // ...and then never another byte.
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    });
    const res = await guardedFetch("https://drip.example/", { maxBytes: 1e6, timeoutMs: 30 });
    expect(res.status).toBe(200);
    expect(await codeOf(res.text())).toBe("timeout");
  });

  it("re-throws the CALLER's abort as-is rather than calling it our timeout", async () => {
    const ctl = new AbortController();
    stubFetch(
      (_u, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
          setTimeout(() => ctl.abort(), 5);
        })
    );
    const err = await guardedFetch("https://slow.example/", {
      maxBytes: 1e6,
      timeoutMs: 10_000,
      signal: ctl.signal,
    }).catch((e) => e);
    expect(err).not.toBeInstanceOf(GuardedFetchError);
    expect((err as Error).name).toBe("AbortError");
  });
});

describe("ordinary pages still work", () => {
  it("returns the page, status and final URL across a public → public redirect", async () => {
    stubFetch((u) =>
      u === "http://fair.example.org/" ? redirect("https://www.fair.example.org/home", 301) : html()
    );
    const res = await guardedFetch("http://fair.example.org/", {
      maxBytes: 1e6,
      accept: "text/html",
    });
    expect(res.status).toBe(200);
    expect(res.url).toBe("https://www.fair.example.org/home");
    expect(res.redirects).toBe(1);
    expect(await res.text()).toContain("grange hall");
  });

  it("fetchStandard returns the HTML and post-redirect URL", async () => {
    stubFetch((u) => (u === "https://a.example/" ? redirect("/events") : html()));
    const out = await fetchStandard("https://a.example/", new AbortController().signal);
    expect(out).toMatchObject({ ok: true, finalUrl: "https://a.example/events" });
  });

  it("passes non-2xx through with its status (the caller decides)", async () => {
    stubFetch(() => new Response("gone", { status: 404 }));
    const res = await guardedFetch("https://a.example/", { maxBytes: 1e6 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("gone");
  });
});
