import { describe, it, expect } from "vitest";
import {
  browseInitial,
  groupByInitial,
  groupByState,
  isBrowseStateCode,
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

/**
 * OPE-643 — the by-state facet enumerated whatever sat in `state`.
 *
 * Every row below is real, read from prod D1 on 2026-08-30. They are NOT dirty
 * data: "Axopar Boats Oy" is a Finnish company in Helsinki, and both ON rows
 * are Ontario businesses. The column is being used as a region field for
 * non-US vendors; the defect is that a facet built on US state names
 * enumerated it and labelled Ontario a state.
 */
describe("groupByState — the facet vocabulary (OPE-643)", () => {
  const PROD = [
    E("Axopar Boats Oy", "FINLAND"),
    E("Rossiter Boats", "ON"),
    E("Allanson Inc", "ON"),
    E("Maine Maple Co", "ME"),
    E("Bay State Crafts", "ma"),
  ];

  it("drops a country name sitting in the state column", () => {
    expect(Array.from(groupByState(PROD).keys())).not.toContain("FINLAND");
  });

  it("drops a Canadian province code", () => {
    // Two-letter and uppercase, so a format check alone would let it through.
    // Only a vocabulary check catches it.
    expect(Array.from(groupByState(PROD).keys())).not.toContain("ON");
  });

  it("keeps every US state and territory, case-insensitively", () => {
    expect(Array.from(groupByState(PROD).keys()).sort()).toEqual(["MA", "ME"]);
    expect(groupByState([E("x", "dc"), E("y", "PR")]).size).toBe(2);
  });

  it("does NOT orphan the excluded vendors — they stay in the A-Z facet", () => {
    // The guard that makes this fix safe. OPE-40 exists so every entity is
    // reachable within ~3 clicks; dropping rows from one facet would break
    // that promise if the letter facet also filtered. It does not.
    const byLetter = groupByInitial(PROD);
    expect(byLetter.get("A")?.map((e) => e.name)).toEqual(["Allanson Inc", "Axopar Boats Oy"]);
    expect(byLetter.get("R")?.map((e) => e.name)).toEqual(["Rossiter Boats"]);
  });

  it("never yields a key the detail route would 404 on", () => {
    // The browse INDEX builds its hrefs from these keys, and the [state] route
    // requires /^[A-Z]{2}$/ then a non-empty bucket. Before the fix the index
    // emitted /vendors/browse/state/finland, which 404s — a crawlable hub
    // linking to a dead page. Encoded as an invariant over the keys.
    for (const code of groupByState(PROD).keys()) {
      expect(code).toMatch(/^[A-Z]{2}$/);
      expect(stateLabel(code)).not.toBe(code); // resolves to a real name
    }
  });
});

describe("isBrowseStateCode (OPE-643)", () => {
  it("accepts US states and territories in any case or padding", () => {
    for (const c of ["ME", "me", " vt ", "DC", "pr"]) expect(isBrowseStateCode(c)).toBe(true);
  });
  it("rejects non-US values, blanks and unknown codes", () => {
    for (const c of ["ON", "FINLAND", "XX", "", "   ", null, undefined])
      expect(isBrowseStateCode(c)).toBe(false);
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
