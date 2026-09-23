/**
 * OPE-1120 — BOTH promoter-merge paths call the shared child-repoint helper,
 * and call it BEFORE the hard delete.
 *
 * The defect was two parallel merge paths (the MCP tool and this app route)
 * that each deleted the loser without repointing its FK-less children. The
 * behaviour is tested end-to-end on the MCP path; this pins that the app path
 * is wired to the same function, so a fix cannot reach one path and miss the
 * other. Anchored on CALL syntax (a bare symbol also matches the import line).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(__dirname, "../../../..", p), "utf8");

function callBeforeDelete(src: string, deleteCall: string) {
  const call = src.search(/await repointPromoterChildren\(\s*db,/);
  const del = src.indexOf(deleteCall);
  return { call, del };
}

describe("OPE-1120 wiring", () => {
  it("app mergePromoters repoints children before deleting the loser", () => {
    const src = read("src/lib/duplicates/merge-operations.ts");
    const body = src.slice(src.indexOf("async function mergePromoters("));
    const { call, del } = callBeforeDelete(
      body,
      "await db.delete(promoters).where(eq(promoters.id, duplicateId));"
    );
    expect(call).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(call);
  });

  it("MCP merge_promoter repoints children before deleting the loser", () => {
    const src = read("mcp-server/src/tools/admin-merge-entities.ts");
    const body = src.slice(src.indexOf('"merge_promoter"'));
    const { call, del } = callBeforeDelete(
      body,
      "await db.delete(promoters).where(eq(promoters.id, params.duplicate_promoter_id));"
    );
    expect(call).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(call);
  });
});
