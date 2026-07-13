/**
 * OPE-193 — resolveShareRedirect / isShareRedirectHost.
 *
 * The resolver does ONE manual-redirect hop with a browser UA and returns the
 * resolved real URL only when it's safe + useful to fetch. These tests pin the
 * guard matrix: real page → resolve; 429/no-Location/loop/denylist/SSRF/
 * video-social target → null (caller falls through to OPE-185 body-extract).
 */
import { describe, it, expect, afterEach } from "vitest";
import { isShareRedirectHost, resolveShareRedirect } from "../src/email-handlers/share-redirect.js";

let lastRequestedUrl: string | null = null;
let originalFetch: typeof globalThis.fetch;

/** Stub fetch to return one redirect response (or throw). */
function stubRedirect(opts: { status?: number; location?: string | null; throws?: boolean }) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    lastRequestedUrl = typeof url === "string" ? url : url.toString();
    if (opts.throws) throw new Error("network");
    const headers = new Headers();
    if (opts.location != null) headers.set("location", opts.location);
    return { status: opts.status ?? 302, headers, body: null } as unknown as Response;
  }) as typeof fetch;
}

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  lastRequestedUrl = null;
});

describe("isShareRedirectHost (OPE-193)", () => {
  it("matches the non-denylisted share hosts", () => {
    expect(isShareRedirectHost("https://share.google/abcd")).toBe(true);
    expect(isShareRedirectHost("https://g.co/kgs/xyz")).toBe(true);
    expect(isShareRedirectHost("https://youtu.be/dQw4")).toBe(true);
    expect(isShareRedirectHost("https://fb.me/e/xyz")).toBe(true);
  });

  it("does not match ordinary or denylisted-shortener hosts", () => {
    expect(isShareRedirectHost("https://realfair.com/event/1")).toBe(false);
    expect(isShareRedirectHost("https://bit.ly/xyz")).toBe(false); // handled upstream by denylist
    expect(isShareRedirectHost("not a url")).toBe(false);
  });
});

describe("resolveShareRedirect (OPE-193)", () => {
  it("returns the resolved real URL on a 3xx → structured page", async () => {
    stubRedirect({ status: 302, location: "https://realfair.com/event/summer-fair" });
    const out = await resolveShareRedirect("https://share.google/abcd");
    expect(out).toBe("https://realfair.com/event/summer-fair");
    expect(lastRequestedUrl).toBe("https://share.google/abcd");
  });

  it("resolves a relative Location, which stays on the share host → loop guard → null", async () => {
    // A relative Location resolves against the share URL, so it can only land
    // back on the same share host (fb.me) — the loop guard then returns null.
    stubRedirect({ status: 301, location: "/landing/123" });
    expect(await resolveShareRedirect("https://fb.me/e/xyz")).toBeNull();
  });

  it("returns null when the 429 persists (non-3xx)", async () => {
    stubRedirect({ status: 429, location: null });
    expect(await resolveShareRedirect("https://share.google/abcd")).toBeNull();
  });

  it("returns null when there is no Location header", async () => {
    stubRedirect({ status: 302, location: null });
    expect(await resolveShareRedirect("https://share.google/abcd")).toBeNull();
  });

  it("returns null when the target is a video/social/login host", async () => {
    stubRedirect({ status: 302, location: "https://www.youtube.com/watch?v=abc" });
    expect(await resolveShareRedirect("https://youtu.be/abc")).toBeNull();
  });

  it("returns null when the target is SSRF-blocked (private host)", async () => {
    stubRedirect({ status: 302, location: "http://127.0.0.1/admin" });
    expect(await resolveShareRedirect("https://share.google/abcd")).toBeNull();
  });

  it("returns null when the target is a denylisted shortener", async () => {
    stubRedirect({ status: 302, location: "https://bit.ly/another" });
    expect(await resolveShareRedirect("https://share.google/abcd")).toBeNull();
  });

  it("returns null when the target loops back to a share host", async () => {
    stubRedirect({ status: 302, location: "https://share.google/second-hop" });
    expect(await resolveShareRedirect("https://g.co/kgs/xyz")).toBeNull();
  });

  it("returns null when the target is a non-http(s) scheme", async () => {
    stubRedirect({ status: 302, location: "ftp://files.example.com/x" });
    expect(await resolveShareRedirect("https://share.google/abcd")).toBeNull();
  });

  it("returns null when the fetch throws", async () => {
    stubRedirect({ throws: true });
    expect(await resolveShareRedirect("https://share.google/abcd")).toBeNull();
  });
});
