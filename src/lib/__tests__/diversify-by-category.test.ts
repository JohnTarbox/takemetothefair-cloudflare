import { describe, it, expect } from "vitest";
import { diversifyByCategory } from "../diversify-by-category";

// Lightweight fixtures: only the fields the helper reads. `categories` is the
// JSON string SQLite stores; `categories[0]` is the primary type.
const ev = (id: string, ...cats: string[]) => ({ id, categories: JSON.stringify(cats) });

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("diversifyByCategory", () => {
  it("prefers one event per type before doubling up (the 4-farmers-markets case)", () => {
    // Soonest-first pool: 3 farmers markets lead, then a festival and a fair.
    const pool = [
      ev("fm1", "Farmers Market"),
      ev("fm2", "Farmers Market"),
      ev("fm3", "Farmers Market"),
      ev("fest1", "Festival"),
      ev("fair1", "Fair"),
    ];
    // Without diversity this would be [fm1, fm2, fm3, fest1] — three markets.
    expect(ids(diversifyByCategory(pool, 4))).toEqual(["fm1", "fest1", "fair1", "fm2"]);
  });

  it("keeps the earliest event within each category (input order is the tiebreak)", () => {
    const pool = [
      ev("fm1", "Farmers Market"),
      ev("fm2", "Farmers Market"),
      ev("fest1", "Festival"),
    ];
    const out = diversifyByCategory(pool, 2);
    // First distinct type picked is the earlier farmers market, not the later.
    expect(ids(out)).toEqual(["fm1", "fest1"]);
  });

  it("backfills by soonest when fewer distinct types exist than the limit", () => {
    const pool = [
      ev("fm1", "Farmers Market"),
      ev("fm2", "Farmers Market"),
      ev("fm3", "Farmers Market"),
    ];
    // Only one type — pass 1 yields [fm1]; pass 2 backfills in input order.
    expect(ids(diversifyByCategory(pool, 4))).toEqual(["fm1", "fm2", "fm3"]);
  });

  it("returns one of each when types exactly match the limit", () => {
    const pool = [ev("a", "Fair"), ev("b", "Festival"), ev("c", "Market"), ev("d", "Craft")];
    expect(ids(diversifyByCategory(pool, 4))).toEqual(["a", "b", "c", "d"]);
  });

  it("treats missing/empty categories as the synthetic 'Event' type", () => {
    const pool = [
      { id: "n1", categories: null },
      { id: "n2", categories: "[]" },
      ev("fest1", "Festival"),
    ];
    // n1 and n2 both resolve to "Event", so only the first is taken in pass 1;
    // the festival is the second distinct type; n2 backfills last.
    expect(ids(diversifyByCategory(pool, 4))).toEqual(["n1", "fest1", "n2"]);
  });

  it("never returns more than the limit", () => {
    const pool = Array.from({ length: 24 }, (_, i) => ev(`e${i}`, `Type${i}`));
    expect(diversifyByCategory(pool, 4)).toHaveLength(4);
  });

  it("handles an empty pool", () => {
    expect(diversifyByCategory([], 4)).toEqual([]);
  });

  it("does not mutate the input pool", () => {
    const pool = [ev("fm1", "Farmers Market"), ev("fest1", "Festival")];
    const before = ids(pool);
    diversifyByCategory(pool, 4);
    expect(ids(pool)).toEqual(before);
  });
});
