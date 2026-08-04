import { describe, expect, it } from "vitest";
import {
  buildEntityEtag,
  hasSessionCookie,
  isNotModified,
  matchConditionalRoute,
  TEMPLATE_VERSION,
} from "@/lib/conditional-get";

describe("matchConditionalRoute (OPE-332)", () => {
  it("matches the six public detail routes", () => {
    expect(matchConditionalRoute("/events/skowhegan-fair")).toEqual({
      type: "event",
      slug: "skowhegan-fair",
    });
    expect(matchConditionalRoute("/vendors/acme")?.type).toBe("vendor");
    expect(matchConditionalRoute("/venues/hall")?.type).toBe("venue");
    expect(matchConditionalRoute("/promoters/p")?.type).toBe("promoter");
    expect(matchConditionalRoute("/performers/band")?.type).toBe("performer");
    expect(matchConditionalRoute("/blog/post")?.type).toBe("blog");
  });

  it("does NOT match list pages — they are not one entity", () => {
    expect(matchConditionalRoute("/events")).toBeNull();
    expect(matchConditionalRoute("/blog")).toBeNull();
  });

  it("does NOT match deeper paths like /blog/tag/x or a series year", () => {
    // A tag index is not a blog post; giving it a post's validator would let
    // one entity's mtime speak for a page it doesn't control.
    expect(matchConditionalRoute("/blog/tag/fairs")).toBeNull();
    expect(matchConditionalRoute("/events/skowhegan-fair/2026")).toBeNull();
  });

  it("does NOT match a dotted final segment (feed.xml lives under /blog)", () => {
    expect(matchConditionalRoute("/blog/feed.xml")).toBeNull();
  });

  it("ignores unrelated prefixes rather than guessing", () => {
    expect(matchConditionalRoute("/admin/events")).toBeNull();
    expect(matchConditionalRoute("/dashboard/x")).toBeNull();
  });
});

describe("buildEntityEtag (OPE-332)", () => {
  const t = new Date("2026-08-01T12:00:00Z");

  it("is stable for the same entity and mtime", () => {
    expect(buildEntityEtag("event", "a", t)).toBe(buildEntityEtag("event", "a", t));
  });

  it("changes when the entity is edited — the acceptance criterion", () => {
    const later = new Date(t.getTime() + 1000);
    expect(buildEntityEtag("event", "a", t)).not.toBe(buildEntityEtag("event", "a", later));
  });

  it("does not collide across types sharing a slug", () => {
    // /vendors/acme and /venues/acme are different pages.
    expect(buildEntityEtag("vendor", "acme", t)).not.toBe(buildEntityEtag("venue", "acme", t));
  });

  it("is weak — it asserts equivalence, not byte equality", () => {
    expect(buildEntityEtag("event", "a", t).startsWith('W/"')).toBe(true);
  });

  it("carries the template version, so a layout change invalidates", () => {
    // Without this, a site-wide template edit would ship behind stale
    // validators: no entity row changed, so nothing else signals it.
    expect(buildEntityEtag("event", "a", t)).toContain(`v${TEMPLATE_VERSION}`);
  });

  it("tolerates a null mtime instead of throwing", () => {
    expect(buildEntityEtag("event", "a", null)).toContain("-0-");
  });

  it("truncates sub-second precision to match HTTP-date resolution", () => {
    const a = new Date("2026-08-01T12:00:00.100Z");
    const b = new Date("2026-08-01T12:00:00.900Z");
    expect(buildEntityEtag("event", "a", a)).toBe(buildEntityEtag("event", "a", b));
  });
});

describe("isNotModified (OPE-332)", () => {
  const etag = 'W/"event-a-100-v1"';
  const lastModified = new Date(100_000);

  it("304s on an exact If-None-Match", () => {
    expect(isNotModified({ ifNoneMatch: etag, ifModifiedSince: null, etag, lastModified })).toBe(
      true
    );
  });

  it("200s when the entity changed under the client", () => {
    expect(
      isNotModified({
        ifNoneMatch: 'W/"event-a-99-v1"',
        ifModifiedSince: null,
        etag,
        lastModified,
      })
    ).toBe(false);
  });

  it("accepts any member of a candidate list", () => {
    expect(
      isNotModified({
        ifNoneMatch: `W/"other", ${etag}, W/"third"`,
        ifModifiedSince: null,
        etag,
        lastModified,
      })
    ).toBe(true);
  });

  it("honours `*`", () => {
    expect(isNotModified({ ifNoneMatch: "*", ifModifiedSince: null, etag, lastModified })).toBe(
      true
    );
  });

  it("lets If-None-Match OVERRIDE a stale If-Modified-Since (RFC 9110 §13.1.3)", () => {
    // The date says "you're current"; the ETag says otherwise. The ETag is
    // authoritative and MUST win, or an edit within the same second is missed.
    expect(
      isNotModified({
        ifNoneMatch: 'W/"stale"',
        ifModifiedSince: new Date(200_000).toUTCString(),
        etag,
        lastModified,
      })
    ).toBe(false);
  });

  it("304s on If-Modified-Since at or after the mtime", () => {
    expect(
      isNotModified({
        ifNoneMatch: null,
        ifModifiedSince: lastModified.toUTCString(),
        etag,
        lastModified,
      })
    ).toBe(true);
  });

  it("200s when the entity is newer than the client's copy", () => {
    expect(
      isNotModified({
        ifNoneMatch: null,
        ifModifiedSince: new Date(50_000).toUTCString(),
        etag,
        lastModified,
      })
    ).toBe(false);
  });

  it("compares at second resolution, or the 304 path never fires", () => {
    // HTTP-dates carry no milliseconds. Comparing exactly would make a mtime of
    // x.500s always look newer than its own serialized header.
    const withMs = new Date(100_500);
    expect(
      isNotModified({
        ifNoneMatch: null,
        ifModifiedSince: withMs.toUTCString(),
        etag,
        lastModified: withMs,
      })
    ).toBe(true);
  });

  it("200s on an unparseable date rather than guessing", () => {
    expect(
      isNotModified({
        ifNoneMatch: null,
        ifModifiedSince: "not-a-date",
        etag,
        lastModified,
      })
    ).toBe(false);
  });

  it("200s when the client sent no preconditions", () => {
    expect(isNotModified({ ifNoneMatch: null, ifModifiedSince: null, etag, lastModified })).toBe(
      false
    );
  });
});

describe("hasSessionCookie (OPE-332)", () => {
  it("is false for an anonymous request", () => {
    expect(hasSessionCookie(null)).toBe(false);
    expect(hasSessionCookie("theme=dark; consent=1")).toBe(false);
  });

  it("detects the Auth.js session cookie, plain and __Secure- prefixed", () => {
    expect(hasSessionCookie("authjs.session-token=abc")).toBe(true);
    expect(hasSessionCookie("__Secure-authjs.session-token=abc")).toBe(true);
  });

  it("detects the legacy next-auth spelling", () => {
    expect(hasSessionCookie("__Secure-next-auth.session-token=abc")).toBe(true);
  });

  it("finds it when it is not the first cookie", () => {
    expect(hasSessionCookie("theme=dark; __Secure-authjs.session-token=abc; x=1")).toBe(true);
  });

  it("does not fire on a lookalike name", () => {
    // A false positive only costs a missed 304; still, `csrf-token` is not a
    // session and shouldn't suppress validators site-wide.
    expect(hasSessionCookie("authjs.csrf-token=abc")).toBe(false);
    expect(hasSessionCookie("my-authjs.session-tokenish=abc")).toBe(false);
  });
});
