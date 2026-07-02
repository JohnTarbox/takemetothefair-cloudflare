import { describe, it, expect } from "vitest";
import { extractHelpFaqItems } from "@/lib/help-faq";
import { getHelpArticle } from "@/lib/help-articles";

// OPE-62 — the help FAQ parser reads `### Question?` H3 headings from the
// `faq` help article body and pairs each with its answer prose, returning the
// same {question, answer} shape FAQPageSchema consumes.

describe("extractHelpFaqItems", () => {
  it("parses the real `faq` help article to >=3 populated pairs", () => {
    const faq = getHelpArticle("faq");
    expect(faq).toBeDefined();
    const items = extractHelpFaqItems(faq!.body);
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const item of items) {
      expect(item.question.length).toBeGreaterThan(0);
      expect(item.answer.length).toBeGreaterThan(0);
      // Questions come from `### …` headings; the marker must be stripped.
      expect(item.question).not.toMatch(/^#/);
      // Answers must be plain text (markdown syntax stripped).
      expect(item.answer).not.toContain("**");
    }
  });

  it("captures a known question and its answer verbatim", () => {
    const faq = getHelpArticle("faq");
    const items = extractHelpFaqItems(faq!.body);
    const free = items.find((i) => /is it free/i.test(i.question));
    expect(free).toBeDefined();
    expect(free!.answer.toLowerCase()).toContain("free");
  });

  it("returns [] for a body with no ### headings", () => {
    expect(extractHelpFaqItems("Just prose.\n\n## A section\n\nMore prose.")).toEqual([]);
  });

  it("returns [] for empty / nullish input", () => {
    expect(extractHelpFaqItems("")).toEqual([]);
    expect(extractHelpFaqItems(null)).toEqual([]);
    expect(extractHelpFaqItems(undefined)).toEqual([]);
  });

  it("skips a heading with no answer prose", () => {
    const body = "### Question with no answer\n\n### Answered question\n\nHere is the answer.";
    const items = extractHelpFaqItems(body);
    expect(items).toHaveLength(1);
    expect(items[0].question).toBe("Answered question");
  });
});
