import { describe, expect, it } from "vitest";
import { readWranglerConfig, wranglerVars } from "../../../scripts/lib/wrangler-config";
import {
  CAPABILITY_FLAGS,
  resolveCapabilityFlags,
} from "@/lib/analytics-overview/dark-capabilities";
import {
  buildEntityEtag,
  hasSessionCookie,
  isNotModified,
  matchConditionalRoute,
  TEMPLATE_VERSION,
} from "@/lib/conditional-get";
import { parseOccurrenceYear, pickOccurrenceForYear } from "@/lib/series/occurrence-year";
import { eventSeries } from "@/lib/db/schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

  it("does NOT match deeper paths like /blog/tag/x", () => {
    // A tag index is not a blog post; giving it a post's validator would let
    // one entity's mtime speak for a page it doesn't control.
    expect(matchConditionalRoute("/blog/tag/fairs")).toBeNull();
  });

  it("does NOT match a dotted final segment (feed.xml lives under /blog)", () => {
    expect(matchConditionalRoute("/blog/feed.xml")).toBeNull();
  });

  it("ignores unrelated prefixes rather than guessing", () => {
    expect(matchConditionalRoute("/admin/events")).toBeNull();
    expect(matchConditionalRoute("/dashboard/x")).toBeNull();
  });
});

/**
 * OPE-1291 — the series/year occurrence page. OPE-332 deliberately matched only
 * two segments, and so gave no validator to /events/<series>/<year>, where 406
 * of 469 upcoming APPROVED events (87%) are served.
 */
describe("matchConditionalRoute — series/year occurrence (OPE-1291)", () => {
  it("matches /events/<series>/<year>, carrying the year", () => {
    expect(matchConditionalRoute("/events/freeport-fall-festival/2026")).toEqual({
      type: "event-occurrence",
      slug: "freeport-fall-festival",
      segment: "2026",
    });
  });

  it("does NOT match other three-segment shapes", () => {
    expect(matchConditionalRoute("/events/skowhegan-fair/vendors")).toBeNull();
    expect(matchConditionalRoute("/events/maine/portland")).toBeNull();
    expect(matchConditionalRoute("/events/skowhegan-fair/26")).toBeNull();
    expect(matchConditionalRoute("/events/skowhegan-fair/20261")).toBeNull();
    expect(matchConditionalRoute("/vendors/acme/2026")).toBeNull();
    expect(matchConditionalRoute("/events/x/y/2026")).toBeNull();
  });

  it("two-segment matching is unchanged (no year key)", () => {
    expect(matchConditionalRoute("/events/skowhegan-fair")).toEqual({
      type: "event",
      slug: "skowhegan-fair",
    });
  });

  it("the ETag names the year, so two years of one series never share a validator", () => {
    const t = new Date("2026-09-01T00:00:00Z");
    const a = buildEntityEtag("event-occurrence", "freeport-fall-festival", t, "2026");
    const b = buildEntityEtag("event-occurrence", "freeport-fall-festival", t, "2027");
    expect(a).toBe(
      `W/"event-occurrence-freeport-fall-festival-2026-${t.getTime() / 1000}-v${TEMPLATE_VERSION}"`
    );
    expect(a).not.toBe(b);
  });
});

describe("the occurrence the validator describes is the one the page renders (OPE-1291)", () => {
  const occ = [
    { slug: "ff-2025", startDate: new Date("2025-09-20T12:00:00Z") },
    { slug: "ff-2026", startDate: new Date("2026-09-19T12:00:00Z") },
    { slug: "undated", startDate: null },
  ];
  it("one shared picker, by UTC start year", () => {
    expect(pickOccurrenceForYear(occ, 2026)?.slug).toBe("ff-2026");
    expect(pickOccurrenceForYear(occ, 2024)).toBeUndefined();
  });
  it("year parsing rejects non-canonical strings exactly as the page does", () => {
    expect(parseOccurrenceYear("2026")).toBe(2026);
    expect(parseOccurrenceYear("02026")).toBeNull();
    expect(parseOccurrenceYear("2026x")).toBeNull();
  });
  it("the page resolver and the middleware both use it (no second copy of the rule)", () => {
    const resolver = readFileSync(join(process.cwd(), "src/lib/series/get-occurrence.ts"), "utf8");
    const mw = readFileSync(join(process.cwd(), "src/middleware.ts"), "utf8");
    // OPE-1326 — the rule is now the shared resolver (year OR edition key),
    // called with the series' edition_mode in both. Anchored on the CALL, so an
    // import line can't satisfy it.
    expect(resolver).toContain("resolveOccurrence(seriesSlug, series.editionMode, occ, segment)");
    expect(mw).toContain("resolveOccurrence(slug, series.editionMode, occ, parsed)");
    // Same population: public occurrences only, in both.
    expect(resolver).toMatch(/eq\(events\.seriesId, series\.id\), isPublicEventStatus\(\)/);
    expect(mw).toMatch(/eq\(events\.seriesId, series\.id\), isPublicEventStatus\(\)/);
  });
  it("the validator is the later of series and occurrence updated_at (the page renders both)", () => {
    const mw = readFileSync(join(process.cwd(), "src/middleware.ts"), "utf8");
    expect(mw).toContain("return latestOf(series.u, r.occurrence.u);");
  });
  it("a series edit moves updated_at — otherwise a rename would 304 to the old name", () => {
    expect(typeof (eventSeries.updatedAt as unknown as { onUpdateFn?: unknown }).onUpdateFn).toBe(
      "function"
    );
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

/**
 * OPE-332 — John flipped `CONDITIONAL_GET_PUBLIC_CACHE` on 2026-10-04 ("turn it
 * on"). The validators keep being emitted whether the flag is on or off, so a
 * silent revert changes nothing visible except `Cache-Control` — this pins the
 * committed value (the realistic revert path; a dashboard override is wiped by
 * the next deploy, OPE-284) and keeps the flag on the live capability inventory,
 * where a revert reads as dark.
 */
describe("OPE-332 — the public cache policy is ON and stays visible", () => {
  it('wrangler.toml top-level [vars] sets CONDITIONAL_GET_PUBLIC_CACHE = "true"', () => {
    // OPE-1292 — parsed: top-level [vars] only, never an [env.*.vars] copy.
    const vars = wranglerVars(readWranglerConfig("main"));
    // Positive landmark: the key exists before its value is asserted.
    expect(vars).toHaveProperty("CONDITIONAL_GET_PUBLIC_CACHE");
    expect(
      vars.CONDITIONAL_GET_PUBLIC_CACHE,
      "John turned this on 2026-10-04; reverting it is his call"
    ).toBe("true");
  });

  it('is on the capability inventory, and a revert to "false" reads as dark and NOT deliberate', () => {
    const flag = CAPABILITY_FLAGS.find((f) => f.name === "CONDITIONAL_GET_PUBLIC_CACHE");
    expect(flag).toMatchObject({ worker: "main-app", offIsDeliberate: false });
    const [off] = resolveCapabilityFlags({ CONDITIONAL_GET_PUBLIC_CACHE: "false" }, [flag!]);
    const [on] = resolveCapabilityFlags({ CONDITIONAL_GET_PUBLIC_CACHE: "true" }, [flag!]);
    expect(off.dark).toBe(true);
    expect(on.dark).toBe(false);
  });
});
