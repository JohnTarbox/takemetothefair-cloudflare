/**
 * OPE-1105 — a table name reaches raw SQL only through the sqlite_master
 * allow-list, and the two admin database routes cannot bypass it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quoteKnownTable, UnknownTableError } from "../known-table-identifier";

const KNOWN = new Set(["events", "vendors", 'odd"name']);

describe("quoteKnownTable", () => {
  it("quotes a table that sqlite_master returned", () => {
    expect(quoteKnownTable("events", KNOWN)).toBe('"events"');
  });

  it("REFUSES a name that is not in the list — the would-be ?table= injection", () => {
    expect(() => quoteKnownTable('events"; DROP TABLE users; --', KNOWN)).toThrow(
      UnknownTableError
    );
    expect(() => quoteKnownTable("users", KNOWN)).toThrow(UnknownTableError);
  });

  it("doubles embedded quotes even for an allow-listed name", () => {
    expect(quoteKnownTable('odd"name', KNOWN)).toBe('"odd""name"');
  });
});

describe("both admin database routes go through it", () => {
  const read = (r: string) =>
    readFileSync(join(__dirname, `../../../app/api/admin/database/${r}/route.ts`), "utf8");

  for (const r of ["stats", "backup"]) {
    it(`${r}: no raw table-name interpolation, and an unknown name maps to 400`, () => {
      const src = read(r);
      // The pre-fix shape, anywhere in the file.
      expect(src).not.toMatch(/"\$\{tableName\}"/);
      expect(src).toMatch(/quoteKnownTable\(tableName, knownTables\)/);
      expect(src).toMatch(/error instanceof UnknownTableError[\s\S]{0,120}status: 400/);
    });
  }
});
