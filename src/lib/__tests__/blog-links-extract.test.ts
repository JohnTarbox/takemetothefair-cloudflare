/**
 * Tests for the markdown-body link extractor in src/lib/blog-links.ts.
 *
 * Covers the BLOG_POST widening landed alongside the content_links
 * reconciliation work — the extractor must now recognize `/blog/<slug>`
 * references and emit them as `BLOG_POST` content-link refs, alongside
 * the existing EVENT/VENDOR/VENUE extraction. Also covers the four
 * broken-slug patterns from the analyst's 2026-05-24 report.
 */

import { describe, expect, it } from "vitest";
import { extractContentLinks } from "../blog-links";

describe("extractContentLinks", () => {
  it("returns an empty list for null / undefined / empty body", () => {
    expect(extractContentLinks(null)).toEqual([]);
    expect(extractContentLinks(undefined)).toEqual([]);
    expect(extractContentLinks("")).toEqual([]);
  });

  it("extracts a single /events/ link", () => {
    expect(extractContentLinks("Check out [Fryeburg Fair](/events/fryeburg-fair-2026).")).toEqual([
      { targetType: "EVENT", targetSlug: "fryeburg-fair-2026" },
    ]);
  });

  it("extracts /vendors/ and /venues/ in the same body", () => {
    const body =
      "Visit [their booth](/vendors/maine-cardworks) at [the hall](/venues/oxford-fairgrounds).";
    const result = extractContentLinks(body);
    expect(result).toContainEqual({ targetType: "VENDOR", targetSlug: "maine-cardworks" });
    expect(result).toContainEqual({ targetType: "VENUE", targetSlug: "oxford-fairgrounds" });
    expect(result).toHaveLength(2);
  });

  it("extracts /blog/ links as BLOG_POST", () => {
    const body = "Related: [our guide](/blog/best-fairs-in-maine-2026).";
    expect(extractContentLinks(body)).toEqual([
      { targetType: "BLOG_POST", targetSlug: "best-fairs-in-maine-2026" },
    ]);
  });

  it("extracts all four target types in a mixed body", () => {
    const body = `
      See [the event](/events/big-fair-2026), [the vendor](/vendors/paint-co),
      [the venue](/venues/town-hall), and [related guide](/blog/inventory-101).
    `;
    const result = extractContentLinks(body);
    expect(result).toHaveLength(4);
    expect(new Set(result.map((r) => r.targetType))).toEqual(
      new Set(["EVENT", "VENDOR", "VENUE", "BLOG_POST"])
    );
  });

  it("deduplicates repeated references", () => {
    // The same /events/ slug appears three times — only one row should
    // be returned. This matches the content_links unique index on
    // (source_type, source_id, target_type, target_slug).
    const body = `
      [first mention](/events/spring-fair-2026)
      again: [second](/events/spring-fair-2026)
      and once more in prose at /events/spring-fair-2026
    `;
    expect(extractContentLinks(body)).toEqual([
      { targetType: "EVENT", targetSlug: "spring-fair-2026" },
    ]);
  });

  it("lowercases slugs (URL paths are case-insensitive in practice)", () => {
    expect(extractContentLinks("/events/Spring-Fair-2026")).toEqual([
      { targetType: "EVENT", targetSlug: "spring-fair-2026" },
    ]);
  });

  it("filters out event listing routes (e.g. /events/past, /events/maine)", () => {
    // These look like /events/<slug> but are static route subpaths in
    // app/events/, not real event slugs. EVENT_LISTING_SLUGS keeps them
    // out of the index.
    expect(extractContentLinks("Browse [recent](/events/past) events")).toEqual([]);
    expect(extractContentLinks("[Maine events](/events/maine)")).toEqual([]);
  });

  it("only matches plural URL forms (singular /event/foo is not a link)", () => {
    // The 301 redirect from /event/* to /events/* (PR #220) handles
    // the typo at the routing layer — the extractor doesn't follow
    // redirects; it just reads the body. Authoring tools should fix
    // the typo upstream, not have the extractor paper over it.
    expect(extractContentLinks("/event/some-fair")).toEqual([]);
    expect(extractContentLinks("/vendor/some-business")).toEqual([]);
    expect(extractContentLinks("/venue/some-hall")).toEqual([]);
  });

  it("ignores trailing-slash and querystring variants gracefully", () => {
    // The regex's `(?=[^a-z0-9-]|$)` lookahead means a trailing slash
    // or `?` terminates the slug cleanly.
    expect(extractContentLinks("/events/foo/")).toEqual([
      { targetType: "EVENT", targetSlug: "foo" },
    ]);
    expect(extractContentLinks("/events/foo?utm_source=x")).toEqual([
      { targetType: "EVENT", targetSlug: "foo" },
    ]);
  });

  it("does not match /eventsfoo (no slash before slug)", () => {
    // Word-boundary protection — the regex requires `/<kind>/<slug>`,
    // not `<kind>foo`.
    expect(extractContentLinks("eventsfoo")).toEqual([]);
    expect(extractContentLinks("/eventssomething")).toEqual([]);
  });

  it("returns refs in body order (callers may rely on stable iteration)", () => {
    const body = `
      First: /blog/intro
      Second: /events/foo
      Third: /vendors/bar
    `;
    const result = extractContentLinks(body);
    expect(result.map((r) => r.targetType)).toEqual(["BLOG_POST", "EVENT", "VENDOR"]);
  });

  // ── Analyst-observed broken-slug patterns ──────────────────────
  // These tests assert the extractor recognizes the SHAPE of the four
  // patterns from the 2026-05-24 report. The extractor's job is just
  // shape recognition; resolving each ref against the live DB is the
  // job of findBrokenContentLinksInDb (which then reports them as
  // broken). What we're guarding here: the extractor mustn't silently
  // skip these patterns and hide them from the broken-link audit.

  it("pattern 1: extracts year-prefix slug (will resolve as broken when DB has year-suffix)", () => {
    // 2026-bangor-craft-fair instead of bangor-craft-fair-2026
    const result = extractContentLinks("see [the fair](/events/2026-bangor-craft-fair)");
    expect(result).toEqual([{ targetType: "EVENT", targetSlug: "2026-bangor-craft-fair" }]);
  });

  it("pattern 2: extracts fabricated name-venue slug (will resolve as broken)", () => {
    // topsfield-fair-topsfield — never existed; pattern-matches an authoring
    // script that concatenated event name + venue name.
    const result = extractContentLinks("[link](/events/topsfield-fair-topsfield)");
    expect(result).toEqual([{ targetType: "EVENT", targetSlug: "topsfield-fair-topsfield" }]);
  });

  it("pattern 3: extracts ordinal-prefix slug (will resolve as broken)", () => {
    // 63rd-… and 46th-annual-… — the discovery task normalizes these to
    // the year-suffix form via event_slug_history, but blog authoring
    // sometimes invents the un-normalized version.
    const a = extractContentLinks("[link](/events/63rd-newport-fair)");
    const b = extractContentLinks("[link](/events/46th-annual-keene-craft-show)");
    expect(a).toEqual([{ targetType: "EVENT", targetSlug: "63rd-newport-fair" }]);
    expect(b).toEqual([{ targetType: "EVENT", targetSlug: "46th-annual-keene-craft-show" }]);
  });

  it("pattern 4 (singular path) is intentionally NOT extracted — Item 5's 301 handles it", () => {
    // /event/foo (singular) is an authoring typo. PR #220 added a route-
    // layer 301 to /events/foo, so the URL works. The extractor still
    // doesn't match singular forms because they're not valid content-link
    // shapes per the regex spec.
    expect(extractContentLinks("[link](/event/some-fair)")).toEqual([]);
  });
});
