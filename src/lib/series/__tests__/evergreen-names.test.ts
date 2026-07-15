import { describe, it, expect } from "vitest";
import { planEvergreenNames, type SeriesNameRow } from "../evergreen-names";

/** Terse row builder — id/slug are incidental to most assertions. */
function row(name: string, id = name.toLowerCase().replace(/\s+/g, "-")): SeriesNameRow {
  return { id, canonicalSlug: id, name };
}

describe("planEvergreenNames", () => {
  it("proposes a rename for a trailing edition year, stripping it", () => {
    const plan = planEvergreenNames([row("Cape Cod Hydrangea Festival 2026")]);
    expect(plan.renames).toHaveLength(1);
    expect(plan.renames[0]).toMatchObject({
      from: "Cape Cod Hydrangea Festival 2026",
      to: "Cape Cod Hydrangea Festival",
      token: "2026",
      century: "20xx",
    });
  });

  it("handles dash-separated and full-ISO-date edition suffixes", () => {
    const plan = planEvergreenNames([
      row("Fryeburg Fair - 2026"),
      row("Rutland Downtown Summer Farmers Market — 2026-05-16"),
    ]);
    expect(plan.renames.map((r) => r.to)).toEqual([
      "Fryeburg Fair",
      "Rutland Downtown Summer Farmers Market",
    ]);
  });

  it("leaves names without a trailing edition token untouched", () => {
    // The ~300 legacy rows whose 4-digit number is not an edition suffix.
    const plan = planEvergreenNames([
      row("Newport Boat Show"),
      row("Route 66 Rally"),
      row("Summer 2026 Kickoff"), // year present but not trailing
    ]);
    expect(plan.renames).toEqual([]);
    expect(plan.totalSeries).toBe(3);
  });

  it("leaves a name that is nothing but a year alone (strip would empty it)", () => {
    // stripNameEditionSuffix's own `stripped || name` guard.
    expect(planEvergreenNames([row("2026")]).renames).toEqual([]);
  });

  it("is idempotent — a second pass over cleaned names proposes nothing", () => {
    const first = planEvergreenNames([row("Whaling City Festival 2026")]);
    const cleaned = first.renames.map((r) => ({ ...row(r.to), id: r.id }));
    expect(planEvergreenNames(cleaned).renames).toEqual([]);
  });

  it("buckets 19xx strips separately for human review, but still plans them", () => {
    const plan = planEvergreenNames([
      row("Big E 2026"),
      row("Topsfield Fair Established since 1950"),
    ]);
    // Both are renames — the 19xx one is surfaced, not silently excluded.
    expect(plan.renames).toHaveLength(2);
    expect(plan.nineteenXx).toHaveLength(1);
    expect(plan.nineteenXx[0]).toMatchObject({
      from: "Topsfield Fair Established since 1950",
      to: "Topsfield Fair Established since",
      century: "19xx",
    });
  });

  it("carves out excluded ids into `excluded` rather than dropping them", () => {
    const plan = planEvergreenNames([row("Keep Me 1950", "keep"), row("Strip Me 2026", "strip")], {
      excludeIds: ["keep"],
    });
    expect(plan.renames.map((r) => r.id)).toEqual(["strip"]);
    expect(plan.excluded.map((r) => r.id)).toEqual(["keep"]);
    // An excluded row is reported, so the operator can see what was spared.
    expect(plan.excluded[0].to).toBe("Keep Me");
  });

  it("reports the total series count regardless of how many change", () => {
    const plan = planEvergreenNames([row("A 2026"), row("B"), row("C 2027")]);
    expect(plan.totalSeries).toBe(3);
    expect(plan.renames).toHaveLength(2);
  });
});
