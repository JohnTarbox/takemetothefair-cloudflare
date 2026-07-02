import { describe, it, expect } from "vitest";
import { truncateAtBoundary, trimTrailingFunctionWord } from "../truncate-meta";

describe("truncateAtBoundary", () => {
  it("returns short strings unchanged (no ellipsis)", () => {
    const s = "A concise meta description.";
    expect(truncateAtBoundary(s, 155)).toBe(s);
  });

  it("returns a string of exactly maxLen unchanged (no ellipsis)", () => {
    const s = "x".repeat(40);
    expect(truncateAtBoundary(s, 40)).toBe(s);
    expect(truncateAtBoundary(s, 40)).not.toContain("…");
  });

  it("trims surrounding whitespace before the length check", () => {
    const s = "   already short   ";
    expect(truncateAtBoundary(s, 155)).toBe("already short");
  });

  it("never cuts mid-word (word-boundary avoidance)", () => {
    const s =
      "Supercalifragilistic exposition featuring artisans craftspeople bakers " +
      "farmers musicians and performers gathering together downtown";
    const out = truncateAtBoundary(s, 60);
    expect(out.endsWith("…")).toBe(true);
    const withoutEllipsis = out.slice(0, -1);
    // The remaining text must be a prefix of the source at a space boundary —
    // i.e. the last retained word is whole.
    expect(s.startsWith(withoutEllipsis)).toBe(true);
    const nextChar = s.charAt(withoutEllipsis.length);
    expect(nextChar === "" || nextChar === " ").toBe(true);
  });

  it("prefers a sentence boundary within the safe region", () => {
    const s =
      "First complete sentence ends here. Then a second much longer clause " +
      "continues rambling on well past the truncation budget without stopping.";
    const out = truncateAtBoundary(s, 60);
    expect(out.endsWith("…")).toBe(true);
    // Should have backed up to the sentence break, dropping the second clause.
    expect(out).toContain("First complete sentence ends here");
    expect(out).not.toContain("second much longer");
    // Trailing sentence punctuation is stripped before the ellipsis.
    expect(out).not.toMatch(/\.\s*…$/);
  });

  it("result never exceeds maxLen", () => {
    const s = "word ".repeat(200);
    for (const max of [40, 100, 155, 160]) {
      expect(truncateAtBoundary(s, max).length).toBeLessThanOrEqual(max);
    }
  });

  it("is idempotent — re-running its own output is a no-op", () => {
    const s =
      "A long description that certainly exceeds the maximum length budget by " +
      "a healthy margin so that truncation must actually occur here for sure.";
    const once = truncateAtBoundary(s, 80);
    const twice = truncateAtBoundary(once, 80);
    expect(twice).toBe(once);
  });

  it("never emits a double ellipsis", () => {
    const s =
      "Another very long description string that will be truncated and then " +
      "re-truncated to make sure we do not stack ellipses on top of each other.";
    const once = truncateAtBoundary(s, 70);
    const twice = truncateAtBoundary(once, 70);
    expect(twice.match(/…/g)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(twice).not.toContain("……");
  });

  it("strips a dangling function word before the ellipsis", () => {
    // Budget lands the cut right after a trailing preposition/conjunction.
    const s =
      "Local produce handmade crafts prepared food and live music for the whole family today";
    const out = truncateAtBoundary(s, 44);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\b(and|for|the|of|a|an|to|in|on|at|with|from)\s*…$/i);
  });

  it("handles null / undefined input", () => {
    expect(truncateAtBoundary(null, 155)).toBe("");
    expect(truncateAtBoundary(undefined, 155)).toBe("");
  });

  it("defaults maxLen to 155", () => {
    const s = "z".repeat(155);
    expect(truncateAtBoundary(s)).toBe(s);
    expect(truncateAtBoundary("z".repeat(400)).length).toBeLessThanOrEqual(155);
  });
});

describe("trimTrailingFunctionWord (re-exported from truncate-meta)", () => {
  it("strips trailing 'and' with preceding comma", () => {
    expect(trimTrailingFunctionWord("locally grown produce, handmade crafts, and")).toBe(
      "locally grown produce, handmade crafts"
    );
  });

  it("preserves trailing periods (sentence completions)", () => {
    expect(trimTrailingFunctionWord("Locally grown produce.")).toBe("Locally grown produce.");
  });
});
