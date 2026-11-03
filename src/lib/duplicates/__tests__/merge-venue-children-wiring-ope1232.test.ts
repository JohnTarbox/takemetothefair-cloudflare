/**
 * OPE-1232 — BOTH venue-merge paths call the shared child-repoint helper, and
 * call it BEFORE the loser is tombstoned (MCP) or hard-deleted (app). The
 * behaviour is tested against real SQLite on the MCP side
 * (mcp-server/__tests__/merge-venue-children-ope1232.test.ts); this pins that
 * the app path is wired to the same function. Anchored on CALL syntax.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(__dirname, "../../../..", p), "utf8");

describe("OPE-1232 wiring", () => {
  it("app mergeVenues repoints children before deleting the loser", () => {
    const src = read("src/lib/duplicates/merge-operations.ts");
    const body = src.slice(src.indexOf("async function mergeVenues("));
    const call = body.search(/await repointVenueChildren\(\s*db,/);
    const del = body.indexOf("db.delete(venues).where(eq(venues.id, duplicateId))");
    expect(call).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(call);
  });

  it("MCP merge_venue repoints children before tombstoning the loser", () => {
    const src = read("mcp-server/src/tools/admin-merge-entities.ts");
    const body = src.slice(src.indexOf('"merge_venue"'));
    const call = body.search(/await repointVenueChildren\(\s*db,/);
    const tomb = body.indexOf('.set({ status: "INACTIVE", slug: tombstoneSlug');
    expect(call).toBeGreaterThan(-1);
    expect(tomb).toBeGreaterThan(call);
  });
});
