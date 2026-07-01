import { describe, it, expect } from "vitest";
import {
  browseInitial,
  groupByInitial,
  groupByState,
  stateLabel,
  stateSlug,
  BROWSE_LETTERS,
  type BrowseEntry,
} from "@/lib/browse/directory";

const E = (name: string, state: string | null = null): BrowseEntry => ({
  slug: name.toLowerCase().replace(/\s+/g, "-"),
  name,
  state,
});

describe("browseInitial", () => {
  it.each([
    ["Apple", "A"],
    ["zebra", "Z"],
    ["  spaced", "S"],
    ["123 Market", "#"],
    ["#hashtag", "#"],
    ["", "#"],
  ])("%s -> %s", (input, expected) => {
    expect(browseInitial(input)).toBe(expected);
  });
});

describe("BROWSE_LETTERS", () => {
  it("is A–Z plus the # catch-all", () => {
    expect(BROWSE_LETTERS).toHaveLength(27);
    expect(BROWSE_LETTERS[0]).toBe("A");
    expect(BROWSE_LETTERS[25]).toBe("Z");
    expect(BROWSE_LETTERS[26]).toBe("#");
  });
});

describe("groupByInitial", () => {
  it("buckets by first letter and sorts each bucket by name", () => {
    const g = groupByInitial([E("Beta"), E("Apple"), E("apron"), E("9 Lives")]);
    expect(g.get("A")?.map((e) => e.name)).toEqual(
      ["apron", "Apple"].sort((a, b) => a.localeCompare(b))
    );
    expect(g.get("B")?.map((e) => e.name)).toEqual(["Beta"]);
    expect(g.get("#")?.map((e) => e.name)).toEqual(["9 Lives"]);
  });
});

describe("groupByState", () => {
  it("groups by uppercased code and skips blanks", () => {
    const g = groupByState([E("A", "me"), E("B", "ME"), E("C", ""), E("D", null), E("E", "vt")]);
    expect(g.get("ME")?.map((e) => e.name)).toEqual(["A", "B"]);
    expect(g.get("VT")?.map((e) => e.name)).toEqual(["E"]);
    expect(g.has("")).toBe(false);
    // blank/null states are dropped entirely
    expect(Array.from(g.keys()).sort()).toEqual(["ME", "VT"]);
  });
});

describe("stateLabel / stateSlug", () => {
  it("maps known codes to names, echoes unknown", () => {
    expect(stateLabel("ME")).toBe("Maine");
    expect(stateLabel("me")).toBe("Maine");
    expect(stateLabel("XX")).toBe("XX");
  });
  it("slugs codes lowercase", () => {
    expect(stateSlug("ME")).toBe("me");
    expect(stateSlug(" vt ")).toBe("vt");
  });
});
