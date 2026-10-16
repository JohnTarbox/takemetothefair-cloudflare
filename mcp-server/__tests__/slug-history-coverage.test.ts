import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * OPE-495 — every MCP write path that can rename an entity must record it.
 *
 * The defect: `update_promoter` and `update_venue` regenerate the slug from
 * `name` through the same collision loop `update_event` uses, but never wrote
 * their `*_slug_history` row. A rename therefore changed the public URL and left
 * the old one 404ing. It went unnoticed for the life of both tables — measured
 * 2026-08-20, all 10 promoter and all 10 venue history rows were admin-UI
 * writes; not one had ever come from MCP.
 *
 * This is a source-level guard because the gap is an ABSENCE. No runtime test
 * fails when a history row is not written — the tool call succeeds, returns the
 * new slug, and reports success. Only the missing redirect shows up later.
 *
 * OPE-1373 — promoter / venue / vendor renames now go through the shared
 * `planSlugRename()` (packages/db-schema/src/slug-rename.ts), which builds the
 * history INSERT itself; the per-entity call sites are pinned below and in
 * the app-side `src/__tests__/slug-rename-guard-ope1373.test.ts`.
 *
 * Anchored on the CALL syntax, never the bare symbol: the symbol also appears
 * on the import line, so a bare-name check would pass vacuously on a file that
 * imports the helper and never uses it.
 */
const DIR = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(DIR, rel), "utf8");

const ADMIN = read("../src/tools/admin.ts");
const PERFORMERS = read("../src/tools/admin-performers.ts");

describe("slug-history write coverage (OPE-495)", () => {
  it.each([
    ["eventSlugHistory", ADMIN],
    ["performerSlugHistory", PERFORMERS],
  ])("%s is actually INSERTed into, not merely imported", (table, source) => {
    expect(source).toContain(`insert(${table})`);
  });

  it.each([
    ["promoter", 1], // update_promoter
    ["venue", 2], // update_venue + update_event's venue side-effect
    ["vendor", 2], // update_vendor + update_vendor_status custom_slug
  ])("OPE-1373: %s renames go through planSlugRename (%i call sites)", (entity, expected) => {
    const calls = ADMIN.match(new RegExp(`planSlugRename\\(db, "${entity}"`, "g")) ?? [];
    expect(calls.length).toBe(expected);
  });

  it("the bare-symbol check this guard deliberately avoids would be weaker", () => {
    // Documents why the assertion above is shaped the way it is: the symbol
    // appears on the import line, so `toContain(table)` cannot distinguish
    // "imported and used" from "imported and forgotten".
    expect(ADMIN).toContain("eventSlugHistory,"); // the import line alone
    expect(ADMIN.indexOf("eventSlugHistory")).toBeLessThan(
      ADMIN.indexOf("insert(eventSlugHistory)")
    );
  });
});
