/**
 * OPE-157 — sort helpers behind the admin email lists' click-to-sort headers.
 */
import { describe, it, expect } from "vitest";
import { nextSort, sortBy } from "../sortable-table";

describe("nextSort", () => {
  it("starts a new column at desc; re-click flips direction", () => {
    expect(nextSort({ col: "sentAt", dir: "desc" }, "recipient")).toEqual({
      col: "recipient",
      dir: "desc",
    });
    expect(nextSort({ col: "recipient", dir: "desc" }, "recipient")).toEqual({
      col: "recipient",
      dir: "asc",
    });
    expect(nextSort({ col: "recipient", dir: "asc" }, "recipient")).toEqual({
      col: "recipient",
      dir: "desc",
    });
  });
});

describe("sortBy", () => {
  const rows = [
    { name: "Charlie", n: 2, when: "2026-07-02T00:00:00Z" },
    { name: "alice", n: 10, when: "2026-07-10T00:00:00Z" },
    { name: "Bob", n: null as number | null, when: "2026-07-01T00:00:00Z" },
  ];
  const val = (r: (typeof rows)[number], col: string) =>
    col === "n" ? r.n : col === "when" ? Date.parse(r.when) : r.name;

  it("no col → unchanged", () => {
    expect(sortBy(rows, null, "asc", val)).toEqual(rows);
  });

  it("text sort is case-insensitive", () => {
    expect(sortBy(rows, "name", "asc", val).map((r) => r.name)).toEqual([
      "alice",
      "Bob",
      "Charlie",
    ]);
    expect(sortBy(rows, "name", "desc", val).map((r) => r.name)).toEqual([
      "Charlie",
      "Bob",
      "alice",
    ]);
  });

  it("numbers sort numerically (not lexically), nulls last in both directions", () => {
    expect(sortBy(rows, "n", "asc", val).map((r) => r.n)).toEqual([2, 10, null]);
    expect(sortBy(rows, "n", "desc", val).map((r) => r.n)).toEqual([10, 2, null]);
  });

  it("dates sort chronologically via numeric epoch accessor", () => {
    expect(sortBy(rows, "when", "desc", val).map((r) => r.name)).toEqual([
      "alice",
      "Charlie",
      "Bob",
    ]);
  });

  it("does not mutate the input array", () => {
    const copy = [...rows];
    sortBy(rows, "name", "asc", val);
    expect(rows).toEqual(copy);
  });
});
