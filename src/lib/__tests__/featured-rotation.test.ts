import { describe, it, expect } from "vitest";
import { rotateFeaturedVendors, hashStr } from "../featured-rotation";

const items = [
  { id: "v1" },
  { id: "v2" },
  { id: "v3" },
  { id: "v4" },
  { id: "v5" },
  { id: "v6" },
  { id: "v7" },
  { id: "v8" },
];

describe("rotateFeaturedVendors", () => {
  it("returns the same order for the same UTC day", () => {
    const date = new Date("2026-05-01T12:00:00Z");
    const a = rotateFeaturedVendors(items, { date });
    const b = rotateFeaturedVendors(items, { date });
    expect(a).toEqual(b);
  });

  it("returns a different order for a different UTC day", () => {
    // Twenty different days. With 8 items and a hashed shuffle, multiple
    // distinct orderings are expected. We assert that NOT all are equal —
    // robust against the unlikely case where two specific days happen to
    // match while still asserting day-level rotation works.
    const baseMs = new Date("2026-05-01T12:00:00Z").getTime();
    const orders = Array.from({ length: 20 }, (_, i) =>
      rotateFeaturedVendors(items, { date: new Date(baseMs + i * 86400000) })
        .map((x) => x.id)
        .join(",")
    );
    const unique = new Set(orders);
    expect(unique.size).toBeGreaterThan(1);
  });

  it("respects topN", () => {
    const result = rotateFeaturedVendors(items, { topN: 3 });
    expect(result).toHaveLength(3);
  });

  it("topN defaults to 6", () => {
    expect(rotateFeaturedVendors(items)).toHaveLength(6);
  });

  it("places pinned items (featured_priority > 0) above unpinned", () => {
    const mixed = [
      { id: "a", featuredPriority: 0 },
      { id: "b", featuredPriority: 5 },
      { id: "c", featuredPriority: 0 },
      { id: "d", featuredPriority: 10 },
      { id: "e", featuredPriority: 0 },
    ];
    const result = rotateFeaturedVendors(mixed, { topN: 5 });
    // Pinned 'd' (priority 10) and 'b' (priority 5) come first, in that order.
    expect(result[0].id).toBe("d");
    expect(result[1].id).toBe("b");
    expect(
      result
        .slice(2)
        .map((r) => r.id)
        .sort()
    ).toEqual(["a", "c", "e"]);
  });

  it("treats null/undefined priority as 0 (unpinned)", () => {
    const mixed = [
      { id: "a", featuredPriority: null },
      { id: "b", featuredPriority: 1 },
    ];
    const result = rotateFeaturedVendors(mixed);
    expect(result[0].id).toBe("b");
  });

  it("returns empty array for empty input", () => {
    expect(rotateFeaturedVendors([])).toEqual([]);
  });
});

describe("hashStr", () => {
  it("is deterministic", () => {
    expect(hashStr("hello")).toBe(hashStr("hello"));
  });

  it("differs for different inputs (most of the time)", () => {
    expect(hashStr("a")).not.toBe(hashStr("b"));
  });

  it("returns non-negative", () => {
    expect(hashStr("anything")).toBeGreaterThanOrEqual(0);
  });
});
