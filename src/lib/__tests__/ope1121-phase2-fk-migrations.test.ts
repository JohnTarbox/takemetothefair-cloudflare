/**
 * OPE-1121 Phases 2 and 3 — the 15 child-table rebuilds that add foreign keys.
 *
 * Pins what the rehearsal taught. With `PRAGMA defer_foreign_keys = on` (the
 * first draft, and D1's documented advice for migrations), a planted orphan was
 * COPIED into the rebuilt table, the FK was declared anyway, and the migration
 * was recorded: the deferred check never fired. So each file must
 *   - not defer FK checks (none of these touches a parent, so none needs to);
 *   - count orphans explicitly, for EVERY declared reference, in the assertion;
 *   - run that assertion BEFORE the original table is dropped;
 *   - clear its scratch tables first, so a re-run after a failure starts clean.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DIR = resolve(__dirname, "../../../drizzle");
const FILES = readdirSync(DIR)
  .filter((f) => /^03(0[89]|1\d|2[0-2])_ope1121_fk_.+\.sql$/.test(f))
  .sort();

const tableOf = (f: string) => f.replace(/^\d{4}_ope1121_fk_/, "").replace(/\.sql$/, "");

describe("OPE-1121 Phase 2 migrations", () => {
  it("there are exactly 15 (13 Phase 2 + 2 Phase 3), ledger first and delivery events after it", () => {
    expect(FILES).toHaveLength(15);
    const order = FILES.map(tableOf);
    expect(order[0]).toBe("email_send_ledger");
    expect(order.indexOf("email_delivery_events")).toBeGreaterThan(0);
  });

  describe.each(FILES)("%s", (file) => {
    const sql = readFileSync(resolve(DIR, file), "utf8");
    const code = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    const t = tableOf(file);
    const refs = [...code.matchAll(/^\s*(\w+) TEXT[^,\n]*? REFERENCES (\w+)\((\w+)\)/gm)];

    it("does not defer foreign-key checks", () => {
      expect(code).not.toMatch(/defer_foreign_keys\s*=\s*on/i);
    });

    it("declares at least one reference, and counts orphans for every one of them", () => {
      expect(refs.length).toBeGreaterThan(0);
      for (const [, col, parent, pcol] of refs) {
        expect(code).toContain(
          `WHERE c.${col} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${parent} p WHERE p.${pcol} = c.${col})) = 0`
        );
      }
    });

    it("asserts before it drops the original", () => {
      const assertAt = code.indexOf("INSERT INTO _ope1121_count_check");
      const dropAt = code.indexOf(`DROP TABLE ${t};`);
      expect(assertAt).toBeGreaterThan(-1);
      expect(dropAt).toBeGreaterThan(assertAt);
    });

    it("clears leftover scratch tables first, so a re-run starts clean", () => {
      const createAt = code.indexOf(`CREATE TABLE ${t}__ope1121`);
      expect(code.indexOf(`DROP TABLE IF EXISTS ${t}__ope1121;`)).toBeGreaterThan(-1);
      expect(code.indexOf(`DROP TABLE IF EXISTS ${t}__ope1121;`)).toBeLessThan(createAt);
      expect(code.indexOf("DROP TABLE IF EXISTS _ope1121_count_check;")).toBeLessThan(createAt);
    });
  });
});

describe("OPE-1121 Phase 3 — vendor_claim_evidence.user_id stays undeclared", () => {
  // OPE-237 (#791) keeps the registrant id as an audit tombstone when the
  // account goes. An FK would erase it (SET NULL) or delete the row (CASCADE).
  it("0322 declares the vendor FK and no user FK", () => {
    const f = FILES.find((x) => x.includes("vendor_claim_evidence"))!;
    const code = readFileSync(resolve(DIR, f), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(code).toMatch(/vendor_id TEXT NOT NULL REFERENCES vendors\(id\) ON DELETE CASCADE/);
    expect(code).toMatch(/^\s*user_id TEXT,$/m);
  });
});
