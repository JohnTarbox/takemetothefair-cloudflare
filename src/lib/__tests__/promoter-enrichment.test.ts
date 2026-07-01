import { describe, it, expect } from "vitest";
import { computePromoterEnrichment, isPlaceholderDescription } from "@takemetothefair/constants";

// OPE-35 — the pure enqueue helper that every promoter create/update path calls.
// Lives in @takemetothefair/constants; tested here so it runs in the root
// (src/**) Unit Tests CI job.

const FULL = {
  website: "https://acme.example",
  heroImageUrl: "https://cdn/hero.jpg",
  logoUrl: "https://cdn/logo.png",
  description: "Acme runs juried craft fairs across northern New England each fall.",
  socialLinks: '[{"platform":"facebook","url":"https://fb/acme"}]',
  contactEmail: "hi@acme.example",
  contactPhone: null,
};

describe("computePromoterEnrichment — status derivation", () => {
  it("all five fields covered → ENRICHED (coverage all true)", () => {
    const r = computePromoterEnrichment(FULL);
    expect(r.status).toBe("ENRICHED");
    expect(r.coverage).toEqual({
      hero: true,
      logo: true,
      description: true,
      socials: true,
      contact: true,
    });
    expect(JSON.parse(r.coverageJson)).toEqual(r.coverage);
  });

  it("no website + nothing filled → NO_SOURCE", () => {
    const r = computePromoterEnrichment({ website: null });
    expect(r.status).toBe("NO_SOURCE");
    expect(r.coverage.hero).toBe(false);
  });

  it("website present but a field missing → NEEDS_ENRICHMENT", () => {
    const r = computePromoterEnrichment({ ...FULL, heroImageUrl: null });
    expect(r.status).toBe("NEEDS_ENRICHMENT");
    expect(r.coverage.hero).toBe(false);
  });

  it("blank website string counts as no source", () => {
    const r = computePromoterEnrichment({ website: "   ", logoUrl: "x" });
    expect(r.status).toBe("NO_SOURCE");
  });

  it("contact is covered by phone alone", () => {
    const r = computePromoterEnrichment({ website: "https://x", contactPhone: "207-555-1234" });
    expect(r.coverage.contact).toBe(true);
  });
});

describe("computePromoterEnrichment — sticky states", () => {
  it("preserves IN_PROGRESS on an incomplete edit", () => {
    const r = computePromoterEnrichment({ ...FULL, logoUrl: null }, "IN_PROGRESS");
    expect(r.status).toBe("IN_PROGRESS");
  });

  it("preserves BLOCKED on an incomplete edit", () => {
    const r = computePromoterEnrichment({ ...FULL, socialLinks: null }, "BLOCKED");
    expect(r.status).toBe("BLOCKED");
  });

  it("completing coverage overrides a sticky state → ENRICHED", () => {
    const r = computePromoterEnrichment(FULL, "BLOCKED");
    expect(r.status).toBe("ENRICHED");
  });

  it("no website overrides a sticky state → NO_SOURCE", () => {
    const r = computePromoterEnrichment({ website: null }, "IN_PROGRESS");
    expect(r.status).toBe("NO_SOURCE");
  });
});

describe("socials coverage — empty JSON containers count as absent", () => {
  for (const empty of ["[]", "{}", "null", "  ", ""]) {
    it(`socialLinks=${JSON.stringify(empty)} → not covered`, () => {
      const r = computePromoterEnrichment({ website: "https://x", socialLinks: empty });
      expect(r.coverage.socials).toBe(false);
    });
  }
  it("a real social JSON array → covered", () => {
    const r = computePromoterEnrichment({ website: "https://x", socialLinks: '["fb"]' });
    expect(r.coverage.socials).toBe(true);
  });
});

describe("isPlaceholderDescription", () => {
  it.each([
    [null, true],
    ["", true],
    ["   ", true],
    ["Event organizer.", true],
    ["event organizer", true],
    ["Acme Shows is an event organizer.", true], // short auto-gen shape
    ["A genuine, curated description of what this promoter actually does.", false],
  ])("%s → %s", (input, expected) => {
    expect(isPlaceholderDescription(input as string | null)).toBe(expected);
  });

  it("a long description containing the phrase is NOT treated as placeholder", () => {
    const long =
      "Acme is an event organizer that has produced the region's largest craft festival for 30 years running.";
    expect(isPlaceholderDescription(long)).toBe(false);
  });
});
