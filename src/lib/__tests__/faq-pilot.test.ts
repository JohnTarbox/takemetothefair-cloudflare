import { describe, it, expect } from "vitest";
import { parsePilotSlugList } from "../faq-pilot";

describe("parsePilotSlugList", () => {
  it("returns empty set for empty input", () => {
    expect(parsePilotSlugList("")).toEqual(new Set());
  });

  it("parses comma-separated slugs and lowercases them", () => {
    expect(parsePilotSlugList("Acton-Fair,Bangor-Fair")).toEqual(
      new Set(["acton-fair", "bangor-fair"])
    );
  });

  it("trims whitespace around each slug", () => {
    expect(parsePilotSlugList("  acton-fair , bangor-fair  ,fryeburg-fair")).toEqual(
      new Set(["acton-fair", "bangor-fair", "fryeburg-fair"])
    );
  });

  it("ignores empty entries from trailing or doubled commas", () => {
    expect(parsePilotSlugList("acton-fair,,bangor-fair,")).toEqual(
      new Set(["acton-fair", "bangor-fair"])
    );
  });

  it("dedupes (Set semantics)", () => {
    expect(parsePilotSlugList("acton-fair,acton-fair,Acton-Fair")).toEqual(new Set(["acton-fair"]));
  });
});
