import { describe, it, expect } from "vitest";
import { extractBlogFaqItems } from "../blog-faq";

describe("extractBlogFaqItems", () => {
  it("returns [] for null/empty body", () => {
    expect(extractBlogFaqItems(null)).toEqual([]);
    expect(extractBlogFaqItems(undefined)).toEqual([]);
    expect(extractBlogFaqItems("")).toEqual([]);
  });

  it("returns [] for posts without any Q: headings", () => {
    const body = [
      "# Some Pillar Post",
      "",
      "Intro paragraph.",
      "",
      "## Section One",
      "",
      "Body.",
      "",
      "## Section Two",
      "",
      "More body.",
    ].join("\n");
    expect(extractBlogFaqItems(body)).toEqual([]);
  });

  it("returns [] when fewer than 3 Q&A pairs are present", () => {
    const body = [
      "## Q: First question?",
      "First answer.",
      "",
      "## Q: Second question?",
      "Second answer.",
    ].join("\n");
    expect(extractBlogFaqItems(body)).toEqual([]);
  });

  it("extracts 3 Q&A pairs when present", () => {
    const body = [
      "Intro paragraph.",
      "",
      "## Q: How do I apply?",
      "",
      "Submit photos and a description of your work.",
      "",
      "## Q: When are deadlines?",
      "",
      "Most fairs accept applications January through April.",
      "",
      "## Q: How much are booth fees?",
      "",
      "Typically $50 to $400 depending on event size.",
    ].join("\n");

    const items = extractBlogFaqItems(body);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      question: "How do I apply?",
      answer: "Submit photos and a description of your work.",
    });
    expect(items[1].question).toBe("When are deadlines?");
    expect(items[2].question).toBe("How much are booth fees?");
  });

  it("strips markdown formatting from answers", () => {
    const body = [
      "## Q: First?",
      "Answer with **bold** and *italic* and a [link](https://example.com).",
      "",
      "## Q: Second?",
      "Answer with `code` snippet.",
      "",
      "## Q: Third?",
      "Plain answer.",
    ].join("\n");

    const items = extractBlogFaqItems(body);
    expect(items[0].answer).toBe("Answer with bold and italic and a link.");
    // stripMarkdown leaves double-space where inline code was removed; this
    // is good enough for FAQ schema since Google trims runs of whitespace.
    expect(items[1].answer).toMatch(/^Answer with\s+snippet\.$/);
  });

  it("ignores ## Q: lines inside fenced code blocks", () => {
    const body = [
      "## Q: Real question 1?",
      "Answer 1.",
      "",
      "## Q: Real question 2?",
      "Here is some sample markdown:",
      "",
      "```markdown",
      "## Q: Fake question inside code fence",
      "Inside the fence.",
      "```",
      "",
      "Continuing the answer.",
      "",
      "## Q: Real question 3?",
      "Answer 3.",
    ].join("\n");

    const items = extractBlogFaqItems(body);
    expect(items.map((i) => i.question)).toEqual([
      "Real question 1?",
      "Real question 2?",
      "Real question 3?",
    ]);
    // The "## Q:" line inside the fence does NOT spawn a new FAQ entry;
    // it stays inside question 2's answer region. stripMarkdown then
    // removes the fenced code block content entirely from the JSON-LD.
    expect(items[1].answer).not.toContain("Fake question");
    expect(items[1].answer).toContain("sample markdown");
    expect(items[1].answer).toContain("Continuing the answer");
  });

  it("ends a Q&A region at the next H1 or H2 (non-Q) heading", () => {
    const body = [
      "## Q: Q1?",
      "A1.",
      "",
      "## Q: Q2?",
      "A2.",
      "",
      "## Related Resources",
      "[Link 1](https://example.com)",
      "",
      "## Q: Q3?",
      "A3.",
    ].join("\n");

    const items = extractBlogFaqItems(body);
    expect(items.map((i) => i.question)).toEqual(["Q1?", "Q2?", "Q3?"]);
    expect(items[1].answer).toBe("A2.");
  });

  it("preserves H3+ sub-headings inside answers", () => {
    const body = [
      "## Q: How do I get started?",
      "",
      "### Step 1: Gather materials",
      "Start by collecting photos.",
      "",
      "### Step 2: Submit",
      "Submit via the application form.",
      "",
      "## Q: What if I'm rejected?",
      "Many shows accept reapplications.",
      "",
      "## Q: How long does review take?",
      "Two to six weeks.",
    ].join("\n");

    const items = extractBlogFaqItems(body);
    expect(items).toHaveLength(3);
    expect(items[0].answer).toContain("Step 1");
    expect(items[0].answer).toContain("Step 2");
  });

  it("caps at 10 items even with more pairs in the body", () => {
    const body = Array.from(
      { length: 15 },
      (_, i) => `## Q: Question ${i + 1}?\nAnswer ${i + 1}.`
    ).join("\n\n");

    const items = extractBlogFaqItems(body);
    expect(items).toHaveLength(10);
  });

  it("trims leading and trailing whitespace from question text", () => {
    const body = [
      "##   Q  :   How   do   I   apply?   ",
      "Answer 1.",
      "",
      "## Q: Q2?",
      "A2.",
      "",
      "## Q: Q3?",
      "A3.",
    ].join("\n");

    const items = extractBlogFaqItems(body);
    expect(items[0].question).toBe("How   do   I   apply?");
  });

  it("skips Q&A pairs whose answer is empty after stripping", () => {
    const body = [
      "## Q: Empty answer?",
      "",
      "## Q: Has answer?",
      "Body text.",
      "",
      "## Q: Also has answer?",
      "Body text.",
      "",
      "## Q: Another?",
      "Body text.",
    ].join("\n");

    const items = extractBlogFaqItems(body);
    // First Q&A is skipped (empty answer); remaining 3 form a valid set.
    expect(items.map((i) => i.question)).toEqual(["Has answer?", "Also has answer?", "Another?"]);
  });
});
