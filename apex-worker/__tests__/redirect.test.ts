import { describe, expect, it } from "vitest";

import { rewriteRedirectLocation } from "../src/redirect";

/**
 * Unit tests for the apex-proxy Location-host rewrite. The bug this
 * guards: slug-rename 301s built from the origin's request host leak
 * `takemetothefair.pages.dev` because we proxy there. The rewrite must
 * swap the host back to the public apex for upstream-targeted redirects
 * and leave everything else untouched.
 */

const UPSTREAM = "https://takemetothefair.pages.dev";
const APEX = { protocol: "https:", host: "meetmeatthefair.com" };
const BASE = "https://takemetothefair.pages.dev/vendors/old-slug";

describe("rewriteRedirectLocation", () => {
  it("rewrites an absolute upstream-host Location to the public apex (the bug case)", () => {
    expect(
      rewriteRedirectLocation(
        "https://takemetothefair.pages.dev/vendors/granite-state-dock-and-marine-1",
        UPSTREAM,
        APEX,
        BASE
      )
    ).toBe("https://meetmeatthefair.com/vendors/granite-state-dock-and-marine-1");
  });

  it("preserves path + query + hash while swapping the host", () => {
    expect(
      rewriteRedirectLocation(
        "https://takemetothefair.pages.dev/events?page=2#top",
        UPSTREAM,
        APEX,
        BASE
      )
    ).toBe("https://meetmeatthefair.com/events?page=2#top");
  });

  it("resolves a relative Location against the base, then rewrites the host", () => {
    // Some redirect sources emit a path-only Location.
    expect(rewriteRedirectLocation("/vendors/new-slug", UPSTREAM, APEX, BASE)).toBe(
      "https://meetmeatthefair.com/vendors/new-slug"
    );
  });

  it("returns null for a null Location (no rewrite)", () => {
    expect(rewriteRedirectLocation(null, UPSTREAM, APEX, BASE)).toBeNull();
  });

  it("leaves an intentional offsite redirect untouched", () => {
    // A redirect to some external host must NOT be rewritten to the apex.
    expect(
      rewriteRedirectLocation("https://example.com/somewhere", UPSTREAM, APEX, BASE)
    ).toBeNull();
  });

  it("does not rewrite a Location already on the apex host", () => {
    // host !== upstreamHost, so no-op. (Belt-and-suspenders: prevents a
    // double rewrite if the origin ever emits the canonical host itself.)
    expect(
      rewriteRedirectLocation("https://meetmeatthefair.com/vendors/foo", UPSTREAM, APEX, BASE)
    ).toBeNull();
  });

  it("rewrites to whatever public host the client used (e.g. the .workers.dev test domain)", () => {
    // The Worker passes the incoming request host, not a hardcoded apex,
    // so Phase-B testing on *.workers.dev redirects correctly too.
    expect(
      rewriteRedirectLocation(
        "https://takemetothefair.pages.dev/events",
        UPSTREAM,
        { protocol: "https:", host: "meetmeatthefair-edge.example.workers.dev" },
        BASE
      )
    ).toBe("https://meetmeatthefair-edge.example.workers.dev/events");
  });

  it("returns null when env.UPSTREAM is unparseable", () => {
    expect(
      rewriteRedirectLocation("https://takemetothefair.pages.dev/x", "not-a-url", APEX, BASE)
    ).toBeNull();
  });
});
