import { describe, it, expect } from "vitest";
import { blogFaqSource, BLOG_FAQ_MIN_ITEMS } from "./blog-faq-source";

describe("blogFaqSource", () => {
  it("returns 'column' when the faqs JSON has ≥ BLOG_FAQ_MIN_ITEMS valid pairs", () => {
    const faqs = JSON.stringify(
      Array.from({ length: BLOG_FAQ_MIN_ITEMS }, (_, i) => ({
        question: `Q${i}?`,
        answer: `A${i}.`,
      }))
    );
    expect(blogFaqSource(faqs, "## Q: ignored?\nbody")).toBe("column");
  });

  it("falls back to 'markdown' when the column has too few items but the body has ≥3 `## Q:` headings", () => {
    const body = [
      "## Q: How do I apply?",
      "Answer one.",
      "## Q: When is the deadline?",
      "Answer two.",
      "## Q: What's the fee?",
      "Answer three.",
    ].join("\n");
    expect(blogFaqSource("[]", body)).toBe("markdown");
    expect(blogFaqSource(null, body)).toBe("markdown");
  });

  it("returns 'none' when neither source qualifies", () => {
    expect(blogFaqSource(null, null)).toBe("none");
    expect(blogFaqSource("[]", "no headings here")).toBe("none");
    // Two Q: headings — below the threshold of 3
    expect(blogFaqSource(null, "## Q: One?\n\n## Q: Two?")).toBe("none");
  });

  it("returns 'none' on invalid JSON in the faqs column rather than throwing", () => {
    expect(blogFaqSource("{not-json", null)).toBe("none");
  });

  it("rejects column entries that aren't {question, answer} shape", () => {
    const wrongShape = JSON.stringify([
      { q: "Q?", a: "A." },
      { q: "Q?", a: "A." },
      { q: "Q?", a: "A." },
    ]);
    expect(blogFaqSource(wrongShape, null)).toBe("none");
  });

  it("ignores `## Q:` headings inside fenced code blocks", () => {
    const body = [
      "## Q: Real one?",
      "Answer.",
      "```",
      "## Q: Fake one in a code fence?",
      "## Q: Another fake one?",
      "```",
      "## Q: Second real one?",
      "Answer.",
    ].join("\n");
    // Only 2 real Q-headings outside the fence — below the threshold
    expect(blogFaqSource(null, body)).toBe("none");
  });
});
