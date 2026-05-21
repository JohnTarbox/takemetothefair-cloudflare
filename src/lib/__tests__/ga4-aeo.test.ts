import { describe, it, expect } from "vitest";
import { aeoDeltaPercent, AEO_THRESHOLDS, getAeoBucket } from "@/lib/ga4";

describe("getAeoBucket", () => {
  it("buckets canonical ChatGPT hostnames", () => {
    expect(getAeoBucket("chatgpt.com")).toBe("chatgpt");
    expect(getAeoBucket("chat.openai.com")).toBe("chatgpt");
  });

  it("buckets oai.com → chatgpt (OpenAI short-link redirector)", () => {
    expect(getAeoBucket("oai.com")).toBe("chatgpt");
  });

  it("buckets Perplexity hostnames", () => {
    expect(getAeoBucket("perplexity.ai")).toBe("perplexity");
    expect(getAeoBucket("www.perplexity.ai")).toBe("perplexity");
  });

  it("buckets Copilot / Claude / Gemini canonical hostnames", () => {
    expect(getAeoBucket("copilot.microsoft.com")).toBe("copilot");
    expect(getAeoBucket("claude.ai")).toBe("claude");
    expect(getAeoBucket("gemini.google.com")).toBe("gemini");
    expect(getAeoBucket("bard.google.com")).toBe("gemini");
  });

  it("buckets early-mover AI engines into 'other'", () => {
    expect(getAeoBucket("you.com")).toBe("other");
    expect(getAeoBucket("phind.com")).toBe("other");
    expect(getAeoBucket("kagi.com")).toBe("other");
  });

  it("is case-insensitive and tolerates whitespace", () => {
    expect(getAeoBucket("ChatGPT.com")).toBe("chatgpt");
    expect(getAeoBucket("  CLAUDE.AI  ")).toBe("claude");
  });

  it("returns null for non-AI sources", () => {
    expect(getAeoBucket("")).toBeNull();
    expect(getAeoBucket("google")).toBeNull();
    expect(getAeoBucket("facebook.com")).toBeNull();
    expect(getAeoBucket("(direct)")).toBeNull();
  });

  it("returns null for www.bing.com (Copilot Chat is path-scoped, not hostname-separable)", () => {
    // Documents the documented limitation in AEO_DOMAIN_BUCKETS: GA4
    // sessionSource is hostname-only, so www.bing.com/chat traffic blends
    // with organic Bing search and can't be classified.
    expect(getAeoBucket("www.bing.com")).toBeNull();
    expect(getAeoBucket("bing.com")).toBeNull();
  });
});

describe("aeoDeltaPercent", () => {
  it("returns null when previous is below the yellow threshold (low-volume guard)", () => {
    // The yellow threshold (5) is the minimum baseline at which a delta
    // becomes informative — avoids "+200% (1→3)" style noise on a tile
    // designed for early-signal observability.
    expect(aeoDeltaPercent(10, 0)).toBeNull();
    expect(aeoDeltaPercent(10, 1)).toBeNull();
    expect(aeoDeltaPercent(10, AEO_THRESHOLDS.yellow - 1)).toBeNull();
  });

  it("returns the signed % delta at and above the threshold", () => {
    expect(aeoDeltaPercent(10, 5)).toBe(100); // doubled
    expect(aeoDeltaPercent(15, 5)).toBe(200); // tripled
    expect(aeoDeltaPercent(5, 10)).toBe(-50); // halved
    expect(aeoDeltaPercent(8, 10)).toBe(-20);
  });

  it("returns 0 when current equals previous", () => {
    expect(aeoDeltaPercent(10, 10)).toBe(0);
    expect(aeoDeltaPercent(100, 100)).toBe(0);
  });

  it("handles current=0 with non-trivial previous (full drop)", () => {
    expect(aeoDeltaPercent(0, 10)).toBe(-100);
  });
});
