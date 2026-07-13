import { describe, it, expect } from "vitest";
import { inferCategoriesFromName } from "@/lib/url-import/infer-categories";
import { EVENT_CATEGORIES } from "@/lib/constants";

describe("inferCategoriesFromName", () => {
  it("classifies air shows (OPE-186)", () => {
    expect(inferCategoriesFromName("The Great State of Maine Air Show")).toEqual(["Air Show"]);
    expect(inferCategoriesFromName("Great New England Airshow 2026")).toEqual(["Air Show"]);
  });

  it("classifies balloon festivals but not stray 'balloon' mentions (OPE-186)", () => {
    expect(inferCategoriesFromName("Great Falls Balloon Festival")).toEqual(["Balloon Festival"]);
    expect(inferCategoriesFromName("Hot Air Balloon Rally")).toEqual(["Balloon Festival"]);
    // "balloon" without a festival/fest/rally qualifier must NOT match.
    expect(inferCategoriesFromName("Balloon animals at the county fair")).toBeNull();
  });

  it("still classifies the existing high-confidence patterns", () => {
    expect(inferCategoriesFromName("Downtown Craft Fair")).toEqual(["Craft Fair"]);
    expect(inferCategoriesFromName("Classic Car Show")).toEqual(["Car Show"]);
  });

  it("returns null when no keyword matches", () => {
    expect(inferCategoriesFromName("Summer Gala")).toBeNull();
    expect(inferCategoriesFromName(null)).toBeNull();
  });

  it("only ever returns values that exist in EVENT_CATEGORIES", () => {
    const out = inferCategoriesFromName("Air Show and Balloon Festival weekend") ?? [];
    for (const c of out) expect(EVENT_CATEGORIES).toContain(c);
    expect(out).toEqual(["Air Show", "Balloon Festival"]);
  });
});
