/**
 * Guards for the OPE-60 help hub registry. HELP_ARTICLES is a hand-authored
 * TS array whose bodies are template literals rendered as Markdown, so these
 * tests protect the invariants that are easy to break by hand:
 *   - unique, non-empty slugs and complete metadata
 *   - every category is one of the 7 known hub sections
 *   - searchHelpArticles matches + respects its limit
 *   - no body accidentally uses a triple-backtick fence (would terminate the
 *     enclosing template literal — see the constraint documented in the file)
 */
import { describe, it, expect } from "vitest";
import { HELP_ARTICLES, HELP_SECTIONS, getHelpArticle, searchHelpArticles } from "../help-articles";

describe("HELP_ARTICLES registry", () => {
  it("has unique, non-empty slugs", () => {
    const slugs = HELP_ARTICLES.map((a) => a.slug);
    for (const slug of slugs) {
      expect(slug.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("gives every article a title, description, body, and category", () => {
    for (const a of HELP_ARTICLES) {
      expect(a.title.trim().length, `title for ${a.slug}`).toBeGreaterThan(0);
      expect(a.description.trim().length, `description for ${a.slug}`).toBeGreaterThan(0);
      expect(a.body.trim().length, `body for ${a.slug}`).toBeGreaterThan(0);
      expect(a.audience.trim().length, `audience for ${a.slug}`).toBeGreaterThan(0);
      expect(a.category.trim().length, `category for ${a.slug}`).toBeGreaterThan(0);
    }
  });

  it("uses only the 7 known hub sections as categories", () => {
    for (const a of HELP_ARTICLES) {
      expect(HELP_SECTIONS as readonly string[], `category for ${a.slug}`).toContain(a.category);
    }
  });

  it("populates all five audience sections plus FAQ and Glossary", () => {
    const categories = new Set(HELP_ARTICLES.map((a) => a.category));
    for (const section of HELP_SECTIONS) {
      expect(categories, `section ${section} has at least one article`).toContain(section);
    }
  });

  it("never uses a triple-backtick fence in a body (template-literal guard)", () => {
    for (const a of HELP_ARTICLES) {
      expect(a.body.includes("```"), `body for ${a.slug} has a fenced code block`).toBe(false);
    }
  });

  it("getHelpArticle resolves a known slug and returns undefined for unknown", () => {
    expect(getHelpArticle("faq")?.title).toBe("Frequently Asked Questions");
    expect(getHelpArticle("does-not-exist")).toBeUndefined();
  });
});

describe("searchHelpArticles", () => {
  it("matches a known term (case-insensitive) — 'claim' returns the claim guides", () => {
    const results = searchHelpArticles("claim");
    const slugs = results.map((r) => r.slug);
    expect(slugs).toContain("claim-your-vendor-listing");
    expect(slugs).toContain("claim-your-organization");
  });

  it("returns the projected shape (slug/title/category only)", () => {
    const [first] = searchHelpArticles("claim");
    expect(Object.keys(first).sort()).toEqual(["category", "slug", "title"]);
  });

  it("respects the limit", () => {
    // "the" appears across many bodies; cap at 2 and confirm the cap holds.
    const results = searchHelpArticles("the", 2);
    expect(results.length).toBe(2);
  });

  it("returns nothing for too-short or non-matching queries", () => {
    expect(searchHelpArticles("a")).toEqual([]);
    expect(searchHelpArticles("zzzzznotathing")).toEqual([]);
  });
});
