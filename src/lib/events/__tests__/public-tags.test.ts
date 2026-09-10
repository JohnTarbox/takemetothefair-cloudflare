/**
 * OPE-884 — the public/internal tag split.
 *
 * Every case here asserts BOTH directions (OPE-6 v3.8 obligation 2): a filter
 * that dropped everything would satisfy "the internal token is gone" while
 * silently emptying the chip row, so each test that removes something also
 * names what must survive.
 */
import { describe, it, expect } from "vitest";
import { filterPublicTags, isInternalTag, LEGACY_INTERNAL_TAGS } from "../public-tags";

/**
 * The live specimen from the ticket, verbatim from D1:
 * events.slug = 'italian-feast-of-saints-cosmas-and-damian-2026' (246 views).
 */
const SPECIMEN = [
  "src:daily-discovery",
  "massachusetts",
  "middlesex-county",
  "cultural-festival",
  "italian",
  "food-vendors",
  "free-admission",
  "needs-enrichment",
  "needs-enrichment:image",
];

describe("the OPE-884 specimen page", () => {
  it("drops the three internal tokens the visitor was being shown", () => {
    const rendered = filterPublicTags(SPECIMEN);
    expect(rendered).not.toContain("src:daily-discovery");
    expect(rendered).not.toContain("needs-enrichment");
    expect(rendered).not.toContain("needs-enrichment:image");
  });

  it("still shows the six descriptors that actually describe the festival", () => {
    // The positive landmark the acceptance criteria ask for by name: a filter
    // that returned [] would pass the test above and fail this one.
    expect(filterPublicTags(SPECIMEN)).toEqual([
      "massachusetts",
      "middlesex-county",
      "cultural-festival",
      "italian",
      "food-vendors",
      "free-admission",
    ]);
  });

  it("removes exactly three of the nine — no more, no less", () => {
    expect(SPECIMEN).toHaveLength(9);
    expect(filterPublicTags(SPECIMEN)).toHaveLength(6);
  });
});

describe("rule 1 — a namespaced tag is machine-written", () => {
  // Every `src:`/`:`-shaped token measured in production on 2026-09-10.
  it.each([
    "src:daily-discovery",
    "src:web-research",
    "src:poster-submission",
    "src:community-submission",
    "needs-enrichment:image",
    "needs-enrichment:price",
    "admin:hold",
    "internal:whatever",
  ])("hides %s", (tag) => {
    expect(isInternalTag(tag)).toBe(true);
  });

  it("catches a namespace nobody has invented yet — the point of the rule", () => {
    // The old filter prefix-tested `admin:` and `internal:` only, so the
    // discovery pass's `src:` namespace walked straight through it.
    expect(isInternalTag("queue:retry-3")).toBe(true);
    expect(isInternalTag("pipeline:stage-2")).toBe(true);
  });
});

describe("rule 3 — the needs-* workflow family", () => {
  // Every `needs-` token measured in production on 2026-09-10, plus the three
  // the old enumeration already knew about.
  it.each([
    "needs-enrichment",
    "needs-venue",
    "needs-hero-image",
    "needs-review",
    "needs-image",
    "needs-dates",
  ])("hides %s", (tag) => {
    expect(isInternalTag(tag)).toBe(true);
  });

  it("does not hide a descriptor that merely starts with the letters 'need'", () => {
    expect(isInternalTag("needlework")).toBe(false);
    expect(isInternalTag("needlecraft-show")).toBe(false);
  });
});

describe("rule 2 — versioned/qualified tags", () => {
  it("hides fmt.v2", () => {
    expect(isInternalTag("fmt.v2")).toBe(true);
  });
});

describe("legacy names with no structural marker", () => {
  it("hides each one", () => {
    for (const tag of LEGACY_INTERNAL_TAGS) {
      expect(isInternalTag(tag)).toBe(true);
    }
  });

  it("has a non-empty legacy set — an empty one would make the loop vacuous", () => {
    expect(LEGACY_INTERNAL_TAGS.size).toBeGreaterThan(0);
  });
});

describe("visitor-facing descriptors survive", () => {
  it.each([
    "italian",
    "free-admission",
    "massachusetts",
    "middlesex-county",
    "cultural-festival",
    "food-vendors",
    "craft-fair",
    "live-music",
    "family-friendly",
  ])("keeps %s", (tag) => {
    expect(isInternalTag(tag)).toBe(false);
  });

  it("keeps every tag on an event that carries no internal ones", () => {
    const clean = ["maine", "agricultural-fair", "livestock", "midway"];
    expect(filterPublicTags(clean)).toEqual(clean);
  });
});

describe("normalization", () => {
  it("is case-insensitive — a capitalised internal tag is still internal", () => {
    expect(isInternalTag("SRC:Daily-Discovery")).toBe(true);
    expect(isInternalTag("Needs-Enrichment")).toBe(true);
    expect(isInternalTag("Draft")).toBe(true);
  });

  it("ignores surrounding whitespace", () => {
    expect(isInternalTag("  needs-venue  ")).toBe(true);
  });

  it("drops an empty or whitespace-only tag rather than rendering a bare #", () => {
    expect(isInternalTag("")).toBe(true);
    expect(isInternalTag("   ")).toBe(true);
  });

  it("preserves the original casing of what it keeps", () => {
    expect(filterPublicTags(["Italian", "src:daily-discovery"])).toEqual(["Italian"]);
  });
});
