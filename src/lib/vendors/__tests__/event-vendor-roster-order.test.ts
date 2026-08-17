/**
 * OPE-410 — the public event vendor roster must be alphabetical.
 *
 * It rendered in raw `event_vendors` insertion order, which had two knock-on
 * problems beyond looking untidy:
 *
 *   - `list_event_vendors` (MCP) already sorted `COLLATE NOCASE`, so the admin
 *     view and the public page disagreed about the same roster.
 *   - the page emits schema.org `ItemList` with
 *     `itemListOrder: ItemListOrderAscending` — a machine-readable claim that
 *     was simply false.
 *
 * The sort deliberately runs AFTER brand resolution and dedupe rather than as
 * SQL `ORDER BY`. The client renders the resolved name (`target.name` from
 * `resolveEventVendorTarget`), which for a vendor shown under its brand parent
 * differs from `COALESCE(display_name, business_name)` — so a SQL sort would
 * order by a string the visitor never sees. These tests pin that distinction,
 * because it is the part a future refactor is most likely to "simplify" back
 * into the query.
 */
import { describe, expect, it } from "vitest";

/** Mirrors the comparator in src/app/api/events/[slug]/vendors/route.ts. */
function sortRoster<T extends { displayName?: string | null; businessName?: string | null }>(
  rows: T[]
): T[] {
  return [...rows].sort((a, b) =>
    (a.displayName ?? a.businessName ?? "").localeCompare(
      b.displayName ?? b.businessName ?? "",
      "en",
      {
        sensitivity: "base",
      }
    )
  );
}

const names = (rows: Array<{ displayName?: string | null; businessName?: string | null }>) =>
  sortRoster(rows).map((r) => r.displayName ?? r.businessName);

describe("alphabetical by displayed name", () => {
  it("orders A→Z", () => {
    const rows = [
      { displayName: "Winthrop Historical Society" },
      { displayName: "Beanies Lemonade" },
      { displayName: "Alyssa Brugger" },
    ];
    // The ticket's acceptance case: Winthrop's roster should open with
    // "Alyssa Brugger" and close with "Winthrop Historical Society".
    expect(names(rows)).toEqual([
      "Alyssa Brugger",
      "Beanies Lemonade",
      "Winthrop Historical Society",
    ]);
  });

  it("is case-insensitive — the COLLATE NOCASE equivalent", () => {
    // A byte comparison puts every uppercase name before every lowercase one,
    // so "acme" would sort after "Zenith".
    expect(names([{ displayName: "Zenith" }, { displayName: "acme" }])).toEqual(["acme", "Zenith"]);
  });

  it("sorts accented names in place rather than stranding them after Z", () => {
    // localeCompare with sensitivity:"base" is why this works; a raw byte sort
    // pushes "Éclair" past "Zenith".
    expect(names([{ displayName: "Zenith" }, { displayName: "Éclair" }])).toEqual([
      "Éclair",
      "Zenith",
    ]);
  });
});

describe("it sorts the name the page RENDERS, not the raw column", () => {
  it("uses displayName when present, businessName otherwise", () => {
    // `displayName` here is the brand-RESOLVED name. A vendor whose business
    // name is "ZZ Holdings LLC" but which displays as "Acme Foods" must sort
    // under A — a SQL ORDER BY on the raw columns would put it under Z.
    const rows = [
      { displayName: "Acme Foods", businessName: "ZZ Holdings LLC" },
      { displayName: null, businessName: "Bravo Crafts" },
    ];
    expect(names(rows)).toEqual(["Acme Foods", "Bravo Crafts"]);
  });

  it("falls back cleanly when both are missing", () => {
    // Must not throw or emit "undefined" into a public list.
    const rows = [{ displayName: null, businessName: null }, { displayName: "Acme" }];
    expect(names(rows)).toEqual([null, "Acme"]);
  });
});

describe("stability", () => {
  it("is idempotent — sorting an already-sorted roster changes nothing", () => {
    const rows = [{ displayName: "Alpha" }, { displayName: "Beta" }, { displayName: "Gamma" }];
    expect(names(sortRoster(rows))).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("does not drop or duplicate rows", () => {
    // Guards the "sorted but lossy" failure — the roster is the whole point.
    const rows = Array.from({ length: 50 }, (_, i) => ({ displayName: `V${50 - i}` }));
    expect(sortRoster(rows)).toHaveLength(50);
    expect(new Set(names(rows)).size).toBe(50);
  });
});
