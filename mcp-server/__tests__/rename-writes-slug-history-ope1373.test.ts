/**
 * OPE-1373 — every rename of a promoter / venue / vendor writes the
 * `*_slug_history` row the middleware 301s from, and a merge never reports
 * success with its redirect missing.
 *
 * Runtime half of the guard (the source-level half is
 * `src/__tests__/slug-rename-guard-ope1373.test.ts` in the app). Runs the
 * shared `planSlugRename()` and the MCP tools that now use it against the real
 * test schema.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unsafeSlug } from "@takemetothefair/utils";
import { planSlugRename } from "@takemetothefair/db-schema";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { registerMergeEntitiesTools } from "../src/tools/admin-merge-entities.js";
import { registerMergeVendorTool } from "../src/tools/admin-merge-vendor.js";
import { promoters, users, vendors, venues } from "../src/schema.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

const all = (sqlText: string) => raw.prepare(sqlText).all();

beforeEach(() => {
  ({ db, raw } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  registerMergeEntitiesTools(server as never, db, ADMIN_AUTH);
  registerMergeVendorTool(server as never, db, ADMIN_AUTH);
  mock = mockIndexNowFetch();
  db.insert(promoters)
    .values([
      { id: "p1", companyName: "Old Name", slug: unsafeSlug("old-name") },
      { id: "p2", companyName: "Taken", slug: unsafeSlug("taken") },
    ])
    .run();
  db.insert(venues)
    .values([
      {
        id: "v1",
        name: "Old Hall",
        slug: unsafeSlug("old-hall"),
        address: "1 Main",
        city: "A",
        state: "ME",
        zip: "04000",
      },
      {
        id: "v2",
        name: "Taken Hall",
        slug: unsafeSlug("taken-hall"),
        address: "1 Main",
        city: "A",
        state: "ME",
        zip: "04000",
      },
    ] as never)
    .run();
  db.insert(users)
    .values([
      { id: "u-d1", email: "d1@example.com", role: "VENDOR" },
      { id: "u-d2", email: "d2@example.com", role: "VENDOR" },
    ] as never)
    .run();
  db.insert(vendors)
    .values([
      { id: "d1", userId: "u-d1", businessName: "Old Shop", slug: unsafeSlug("old-shop") },
      { id: "d2", userId: "u-d2", businessName: "Taken Shop", slug: unsafeSlug("taken-shop") },
    ] as never)
    .run();
});
afterEach(() => mock.restore());

async function call(tool: string, args: Record<string, unknown>) {
  const r = (await server.invoke(tool, args)) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  return { isError: !!r.isError, text: r.content[0].text };
}

describe("planSlugRename()", () => {
  it("returns null for a no-op (seed equals the current slug)", async () => {
    const plan = await planSlugRename(db as never, "promoter", {
      entityId: "p1",
      currentSlug: unsafeSlug("old-name"),
      seed: unsafeSlug("old-name"),
      changedBy: "u",
    });
    expect(plan).toBeNull();
  });

  it("suffixes past a slug another row holds, and the history row names it", async () => {
    const plan = await planSlugRename(db as never, "promoter", {
      entityId: "p1",
      currentSlug: unsafeSlug("old-name"),
      seed: unsafeSlug("taken"),
      changedBy: "u",
    });
    expect(plan?.nextSlug).toBe("taken-2");
    await plan!.historyInsert;
    expect(all(`SELECT promoter_id, old_slug, new_slug FROM promoter_slug_history`)).toEqual([
      { promoter_id: "p1", old_slug: "old-name", new_slug: "taken-2" },
    ]);
  });
});

describe("MCP update tools write history through the shared helper", () => {
  it("update_promoter rename → promoter_slug_history row", async () => {
    const r = await call("update_promoter", { promoter_id: "p1", name: "New Name" });
    expect(r.isError).toBe(false);
    expect(all(`SELECT old_slug, new_slug FROM promoter_slug_history`)).toEqual([
      { old_slug: "old-name", new_slug: "new-name" },
    ]);
  });

  it("update_promoter with the SAME name writes no history row", async () => {
    await call("update_promoter", { promoter_id: "p1", name: "Old Name" });
    expect(all(`SELECT * FROM promoter_slug_history`)).toEqual([]);
  });

  it("update_venue rename onto a taken slug → suffixed slug + history row", async () => {
    const r = await call("update_venue", { venue_id: "v1", name: "Taken Hall" });
    expect(r.isError).toBe(false);
    expect(all(`SELECT slug FROM venues WHERE id='v1'`)).toEqual([{ slug: "taken-hall-2" }]);
    expect(all(`SELECT old_slug, new_slug FROM venue_slug_history`)).toEqual([
      { old_slug: "old-hall", new_slug: "taken-hall-2" },
    ]);
  });

  it("update_vendor rename → vendor_slug_history row", async () => {
    const r = await call("update_vendor", { vendor_id: "d1", business_name: "New Shop" });
    expect(r.isError).toBe(false);
    expect(all(`SELECT old_slug, new_slug FROM vendor_slug_history`)).toEqual([
      { old_slug: "old-shop", new_slug: "new-shop" },
    ]);
  });

  it("a failing history INSERT fails the rename too (same batch — no orphaned URL)", async () => {
    raw["exec"](
      `CREATE TRIGGER boom BEFORE INSERT ON promoter_slug_history BEGIN SELECT RAISE(ABORT, 'boom'); END;`
    );
    await expect(call("update_promoter", { promoter_id: "p1", name: "New Name" })).rejects.toThrow(
      /boom/
    );
    // better-sqlite3's batch shim is sequential, not transactional, so the
    // UPDATE ran; on D1 the batch is atomic. What this pins is that the
    // failure is SURFACED rather than swallowed as it was by recordSlugRename.
  });
});

describe("merge tools abort, not swallow, a slug-history failure", () => {
  function failHistory(table: string) {
    raw["exec"](
      `CREATE TRIGGER boom_${table} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'history down'); END;`
    );
  }

  it("merge_promoter: the duplicate is NOT deleted when its redirect cannot be written", async () => {
    failHistory("promoter_slug_history");
    const r = await call("merge_promoter", {
      keeper_promoter_id: "p2",
      duplicate_promoter_id: "p1",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/ABORTED/);
    expect(all(`SELECT id FROM promoters WHERE id='p1'`)).toEqual([{ id: "p1" }]);
    expect(all(`SELECT count(*) n FROM error_logs WHERE source='mcp:merge_promoter'`)[0]).toEqual({
      n: 1,
    });
  });

  it("merge_venue: the duplicate is NOT tombstoned when its redirect cannot be written", async () => {
    failHistory("venue_slug_history");
    const r = await call("merge_venue", { keeper_venue_id: "v2", duplicate_venue_id: "v1" });
    expect(r.isError).toBe(true);
    expect(all(`SELECT slug, status FROM venues WHERE id='v1'`)).toEqual([
      { slug: "old-hall", status: "ACTIVE" },
    ]);
  });

  // merge_vendor's write path touches tables the hand-written test DDL does not
  // carry (vendor_self_reported_events, …), so it is pinned at source level:
  // no slug-history INSERT in the merge tools may be followed by a bare catch.
  it("no merge tool swallows a slug-history INSERT with a bare `catch {}`", () => {
    for (const rel of [
      "../src/tools/admin-merge-entities.ts",
      "../src/tools/admin-merge-vendor.ts",
    ]) {
      const src = readFileSync(path.join(DIR, rel), "utf8");
      const re = /insert\((venue|promoter|vendor)SlugHistory\)[\s\S]{0,400}?\}\s*catch\s*\{/g;
      expect(src.match(re), rel).toBeNull();
      expect(src, rel).toMatch(/insert\((venue|promoter|vendor)SlugHistory\)/);
    }
  });

  it("control: with history writable, merge_promoter succeeds and writes the redirect", async () => {
    const r = await call("merge_promoter", {
      keeper_promoter_id: "p2",
      duplicate_promoter_id: "p1",
    });
    expect(r.isError).toBe(false);
    expect(all(`SELECT old_slug, new_slug FROM promoter_slug_history`)).toEqual([
      { old_slug: "old-name", new_slug: "taken" },
    ]);
  });
});
