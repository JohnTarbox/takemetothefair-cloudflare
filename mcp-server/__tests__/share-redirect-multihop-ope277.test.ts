/**
 * OPE-277 — `share.google` grew a second hop, and a one-hop resolver could not
 * see it fail.
 *
 * Measured live 2026-08-23, on all three lost specimens:
 *
 *     share.google/JAFhqhevUuDYKe2Eu
 *       302 -> www.google.com/share.google?q=JAFhqhevUuDYKe2Eu
 *       301 -> www.pressherald.com/2026/08/17/7-maine-events-this-week-...
 *
 * The dangerous part is that hop 1 does not error. It returns a syntactically
 * valid `www.google.com` URL that is in neither SHARE_REDIRECT_HOSTS nor
 * UNFETCHABLE_TARGET_HOSTS, so every guard passed it and the pipeline went off
 * to extract an event from Google's interstitial. PR #782 was merged and live
 * (`3d95da2b`, 2026-07-22) when the 08-17 specimen was lost — re-landing it
 * would have changed nothing.
 *
 * These tests drive a scripted redirect CHAIN rather than a single response,
 * because a one-response stub cannot tell a one-hop resolver from a two-hop one.
 */
import { describe, it, expect, afterEach } from "vitest";
import { resolveShareRedirect } from "../src/email-handlers/share-redirect.js";

let originalFetch: typeof globalThis.fetch;
let requested: string[] = [];

/** Stub fetch with a URL -> Location map; anything unmapped answers 200. */
function stubChain(chain: Record<string, { status?: number; location?: string }>) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const u = typeof url === "string" ? url : url.toString();
    requested.push(u);
    const hop = chain[u];
    const headers = new Headers();
    if (!hop) return { status: 200, headers, body: null } as unknown as Response;
    if (hop.location) headers.set("location", hop.location);
    return { status: hop.status ?? 301, headers, body: null } as unknown as Response;
  }) as typeof fetch;
}

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  requested = [];
});

const SHARE = "https://share.google/JAFhqhevUuDYKe2Eu";
const WAYPOINT = "https://www.google.com/share.google?q=JAFhqhevUuDYKe2Eu";
const ARTICLE =
  "https://www.pressherald.com/2026/08/17/7-maine-events-this-week-include-lewiston-auburn-balloon-festival-jurassic-quest/";

describe("resolveShareRedirect — the live two-hop share.google chain", () => {
  it("resolves through the www.google.com waypoint to the real article", async () => {
    stubChain({
      [SHARE]: { status: 302, location: WAYPOINT },
      [WAYPOINT]: { status: 301, location: ARTICLE },
    });

    expect(await resolveShareRedirect(SHARE)).toBe(ARTICLE);
    // Proof it actually walked the chain rather than getting lucky.
    expect(requested).toEqual([SHARE, WAYPOINT]);
  });

  it("never hands back the interstitial itself", async () => {
    // The precise 08-17 production failure: returning the waypoint sends the
    // pipeline off to extract an event from a Google redirect page.
    stubChain({
      [SHARE]: { status: 302, location: WAYPOINT },
      [WAYPOINT]: { status: 301, location: ARTICLE },
    });

    expect(await resolveShareRedirect(SHARE)).not.toContain("google.com");
  });

  it("still resolves a plain one-hop share link", async () => {
    // OPE-193's original shape must keep working.
    stubChain({ [SHARE]: { status: 301, location: "https://mainelobsterfestival.com/" } });

    expect(await resolveShareRedirect(SHARE)).toBe("https://mainelobsterfestival.com/");
    expect(requested).toEqual([SHARE]);
  });

  it("treats www.google.com OUTSIDE the share paths as a real destination", async () => {
    // The waypoint is matched on host + path prefix. Blanket-blocking
    // google.com would swallow legitimate destinations.
    const page = "https://www.google.com/maps/place/Fryeburg+Fairgrounds";
    stubChain({ [SHARE]: { status: 302, location: page } });

    expect(await resolveShareRedirect(SHARE)).toBe(page);
  });

  it("gives up when the chain never leaves the waypoints", async () => {
    // Bounded, and null so the caller falls through to body/subject extract
    // with extract_fail_reason still recorded. The loudness is the asset.
    const a = "https://www.google.com/share.google?q=a";
    const b = "https://www.google.com/share.google?q=b";
    const c = "https://www.google.com/share.google?q=c";
    const d = "https://www.google.com/share.google?q=d";
    stubChain({
      [SHARE]: { location: a },
      [a]: { location: b },
      [b]: { location: c },
      [c]: { location: d },
      [d]: { location: a },
    });

    expect(await resolveShareRedirect(SHARE)).toBeNull();
    // Bounded by MAX_REDIRECT_HOPS — never an unbounded walk.
    expect(requested.length).toBeLessThanOrEqual(4);
  });

  it("breaks a redirect cycle instead of burning the hop budget", async () => {
    stubChain({
      [SHARE]: { location: WAYPOINT },
      [WAYPOINT]: { location: WAYPOINT },
    });

    expect(await resolveShareRedirect(SHARE)).toBeNull();
  });

  it("stops at an unfetchable social target found on a LATER hop", async () => {
    // The guards must run every hop, not only the first.
    stubChain({
      [SHARE]: { location: WAYPOINT },
      [WAYPOINT]: { location: "https://www.facebook.com/events/123" },
    });

    expect(await resolveShareRedirect(SHARE)).toBeNull();
  });

  it("stops at a denylisted click-tracker found on a LATER hop", async () => {
    stubChain({
      [SHARE]: { location: WAYPOINT },
      [WAYPOINT]: { location: "https://us8.list-manage.com/track/click?u=1" },
    });

    expect(await resolveShareRedirect(SHARE)).toBeNull();
  });

  it("stops at an SSRF target found on a LATER hop", async () => {
    // An open redirect could point hop 2 at an internal address; checking only
    // the first hop would let it through.
    stubChain({
      [SHARE]: { location: WAYPOINT },
      [WAYPOINT]: { location: "http://169.254.169.254/latest/meta-data/" },
    });

    expect(await resolveShareRedirect(SHARE)).toBeNull();
  });

  it("returns null when the 429 persists on hop 1", async () => {
    stubChain({ [SHARE]: { status: 429 } });
    expect(await resolveShareRedirect(SHARE)).toBeNull();
  });

  it("returns null when a later hop stops redirecting without arriving", async () => {
    // Waypoint answers 200 instead of a Location — nothing to follow, and the
    // interstitial itself is not a destination.
    stubChain({ [SHARE]: { status: 302, location: WAYPOINT } });
    expect(await resolveShareRedirect(SHARE)).toBeNull();
  });
});
