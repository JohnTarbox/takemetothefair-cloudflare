/**
 * OPE-537 third failure shape — an event named "Just a moment...".
 *
 * inbound `71853429` (2026-08-24) submitted a bare URL for
 * https://10times.com/e1sk-x49s-29xr. Live headers for that URL:
 *
 *     http/2 403
 *     cf-mitigated: challenge
 *     server: cloudflare
 *     <title>Just a moment...</title>
 *
 * The standard fetch got 403, escalated correctly, and Browser Rendering
 * rendered the CHALLENGE PAGE and returned it as a successful 200. A PENDING
 * event was created with name "Just a moment..." and description
 * "Just a moment... - suggested by the community".
 *
 * The guards already in place ask whether we got BYTES:
 *   PR #1018 — did the fetch fail?  A challenge answers 200.
 *   PR #1017 — is the text empty?   A challenge is ~5.6KB.
 * Neither asks whether the bytes are the document we requested.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectChallengePage, isChallengePage } from "./challenge-page";
import { fetchStandard, fetchViaBrowserRendering, shouldEscalate } from "./browser-rendering";

/** The interstitial's shape, reduced to what a detector can see. */
const CF_CHALLENGE_HTML =
  "<!DOCTYPE html><html><head><title>Just a moment...</title>" +
  '<meta http-equiv="refresh" content="390"></head><body>' +
  '<div id="challenge-error-text">Enable JavaScript and cookies to continue</div>' +
  '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>' +
  "</body></html>";

const REAL_EVENT_HTML =
  "<!DOCTYPE html><html><head><title>Vermont Crafters Expo</title></head><body>" +
  "<h1>Vermont Crafters Expo</h1><p>November 7 and 8, 2026 at the Champlain " +
  "Valley Exposition. Tools, materials, education and resources for makers.</p>" +
  "</body></html>";

describe("detectChallengePage", () => {
  it("catches the specimen by title", () => {
    const v = detectChallengePage(CF_CHALLENGE_HTML);
    expect(v.isChallenge).toBe(true);
    expect(v.vendor).toBe("cloudflare");
  });

  it("catches it by the cf-mitigated header even when the body is unremarkable", () => {
    // The header is authoritative and cheaper than a body scan.
    const v = detectChallengePage(
      "<html><body>nothing telling here</body></html>",
      new Headers({ "cf-mitigated": "challenge" })
    );
    expect(v.isChallenge).toBe(true);
    expect(v.signal).toBe("header");
  });

  it("ignores a cf-mitigated header with any other value", () => {
    expect(isChallengePage(REAL_EVENT_HTML, new Headers({ "cf-mitigated": "block" }))).toBe(false);
  });

  // Each marker gets an ISOLATED fixture. The combined specimen above carries
  // three Cloudflare signals at once, so a test using it stays green when any
  // one marker is deleted — a mutation confirmed exactly that for the title
  // pattern. A detector is only as good as its least-redundant signal, and
  // real interstitials do not always ship all three.
  it.each([
    ["the bare specimen title ALONE", "<html><head><title>Just a moment...</title></head></html>"],
    ["challenge-platform script", '<script src="/cdn-cgi/challenge-platform/x"></script>'],
    ["JS-and-cookies copy", "<p>Enable JavaScript and cookies to continue</p>"],
    ["Attention Required title", "<title>Attention Required! | Cloudflare</title>"],
    ["PerimeterX", "<title>Access to this page has been denied</title>"],
    ["Imperva", "Request unsuccessful. Incapsula incident ID: 123-456"],
    ["Distil", "<title>Pardon Our Interruption</title>"],
  ])("catches %s", (_label, html) => {
    expect(isChallengePage(html)).toBe(true);
  });

  it("does NOT flag a real event page", () => {
    expect(isChallengePage(REAL_EVENT_HTML)).toBe(false);
  });

  it.each([
    ["a fair's photo-policy FAQ", "<p>Access denied to the show ring during judging.</p>"],
    ["robot-themed event copy", "<h1>Are you a robot? Robotics Expo 2027</h1>"],
    ["empty", ""],
    ["null", null],
    ["undefined", undefined],
  ])("does NOT flag %s", (_label, html) => {
    expect(isChallengePage(html)).toBe(false);
  });

  it("scans only the head of a very large document", () => {
    // A real page can be megabytes; a challenge puts its markers in <head>.
    // A marker buried past the scan window is not a challenge page — it is
    // a page that happens to quote one.
    const huge = "<html><body>" + "x".repeat(70000) + "<title>Just a moment...</title></body>";
    expect(isChallengePage(huge)).toBe(false);
  });
});

const ENV = { CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_BROWSER_RENDERING_TOKEN: "t" };

describe("the fetch paths refuse a challenge page", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("fetchStandard refuses a 200 that is really an interstitial", async () => {
    // The shape that would otherwise sail through: status OK, body non-empty.
    global.fetch = vi.fn(
      async () =>
        new Response(CF_CHALLENGE_HTML, {
          status: 200,
          headers: { "content-type": "text/html" },
        })
    ) as unknown as typeof fetch;

    const out = await fetchStandard("https://example.com/x", new AbortController().signal);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.error).toContain("challenge-page");
    expect(out.userMessage).toMatch(/bot-protection/i);
  });

  it("fetchStandard still returns real content untouched", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(REAL_EVENT_HTML, {
          status: 200,
          headers: { "content-type": "text/html" },
        })
    ) as unknown as typeof fetch;

    const out = await fetchStandard("https://example.com/x", new AbortController().signal);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.html).toBe(REAL_EVENT_HTML);
  });

  it("Browser Rendering refuses a rendered interstitial", async () => {
    // The exact call site that produced the "Just a moment..." event. BR
    // reports success; the body is the challenge.
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, result: CF_CHALLENGE_HTML }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    ) as unknown as typeof fetch;

    const out = await fetchViaBrowserRendering("https://10times.com/e1sk-x49s-29xr", ENV);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.error).toContain("browser-rendering-challenge-page");
    expect(out.error).toContain("cloudflare");
  });

  it("a challenge on the standard path ESCALATES to Browser Rendering", async () => {
    // A real browser is the one remaining option. Not escalating would leave
    // the fallback unattempted on the case it was built for.
    expect(
      shouldEscalate({
        ok: false,
        status: 200,
        error: "challenge-page:cloudflare",
        userMessage: "…",
      })
    ).toBe(true);
  });
});
