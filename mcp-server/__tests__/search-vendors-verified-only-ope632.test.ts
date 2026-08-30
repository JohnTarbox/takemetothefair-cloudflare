/**
 * OPE-632 — `verified_only` on `search_vendors`.
 *
 * ⚠️ The ticket's mechanism was wrong in a way worth recording. It reported a
 * declared filter "dropped on the floor" before the WHERE clause. In fact the
 * parameter had NEVER EXISTED: `git log -S verified_only --all` returns no
 * commit that ever added or removed it. An MCP tool silently ignores an
 * argument it does not declare, so a caller passing `verified_only: true` got
 * all 6,567 rows back with no error — the identical symptom from a different
 * cause, and the fix is to ADD the parameter rather than to re-wire one.
 *
 * The failure direction is what makes it dangerous. It did not return zero rows
 * and read as "we have no verified vendors", which somebody would investigate.
 * It returned everything and read as "we have hundreds" — good news, so it gets
 * quoted rather than questioned. True count on prod 2026-08-30: **6** of 6,567.
 *
 * These run the predicate against a real SQLite database and assert on rows
 * that must be EXCLUDED. That is the whole point: a no-op filter passes every
 * include-only assertion, which is exactly how this survived (OPE-530 describes
 * the same gap for parameter validation generally).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/schema.js";
import { vendors } from "../src/schema.js";
import { vendorSearchWhere } from "../src/helpers.js";

const SCHEMA_SQL = `
  CREATE TABLE vendors (
    id TEXT PRIMARY KEY,
    business_name TEXT NOT NULL,
    display_name TEXT,
    slug TEXT NOT NULL UNIQUE,
    vendor_type TEXT,
    verified INTEGER DEFAULT 0,
    deleted_at INTEGER
  );
`;

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

function seed(
  id: string,
  name: string,
  opts: { verified?: boolean; deleted?: boolean; type?: string } = {}
) {
  raw
    .prepare(
      `INSERT INTO vendors (id, business_name, slug, vendor_type, verified, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      name,
      `${id}-slug`,
      opts.type ?? "crafts",
      opts.verified ? 1 : 0,
      opts.deleted ? 1_700_000_000 : null
    );
}

async function search(params: Parameters<typeof vendorSearchWhere>[0]) {
  const rows = await db
    .select({ id: vendors.id, name: vendors.businessName, verified: vendors.verified })
    .from(vendors)
    .where(vendorSearchWhere(params));
  return rows;
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  seed("paid", "Gooseberry Leather Company", { verified: true });
  seed("free", "Ables Trades", { verified: false });
  seed("free2", "Allure Vogue", { verified: false });
  seed("dead", "Sea Bags LLC", { verified: true, deleted: true });
});

describe("verified_only actually narrows", () => {
  it("EXCLUDES an unverified vendor — the assertion a no-op filter fails", () => {
    // The load-bearing test. Every include-only assertion passed while the
    // filter did nothing at all.
    return search({ verified_only: true }).then((rows) => {
      const ids = rows.map((r) => r.id);
      expect(ids).not.toContain("free");
      expect(ids).not.toContain("free2");
      expect(ids).toContain("paid");
    });
  });

  it("reconciles with a direct COUNT — the acceptance check", async () => {
    // Mirrors `SELECT COUNT(*) FROM vendors WHERE verified=1`, which returned
    // 6 on prod while the tool returned 40-with-has_more.
    const rows = await search({ verified_only: true });
    const direct = raw
      .prepare(`SELECT COUNT(*) AS n FROM vendors WHERE verified=1 AND deleted_at IS NULL`)
      .get() as { n: number };
    expect(rows).toHaveLength(direct.n);
  });

  it("still excludes merge tombstones (OPE-566 must not regress)", async () => {
    // 'dead' is verified=1 AND soft-deleted. Both filters have to hold at once,
    // or fixing one silently reopens the other — two defects on one clause in
    // four days is why this is pinned.
    const rows = await search({ verified_only: true });
    expect(rows.map((r) => r.id)).not.toContain("dead");
  });

  it("combines with a query rather than replacing it", async () => {
    // The reported repro: search_vendors("Gooseberry", verified_only:true)
    // returned the row while get_vendor_details said verified=false.
    expect((await search({ query: "Gooseberry", verified_only: true })).map((r) => r.id)).toEqual([
      "paid",
    ]);
    expect(await search({ query: "Ables", verified_only: true })).toHaveLength(0);
  });

  it("omitting verified_only is unchanged — all live rows", async () => {
    const rows = await search({});
    expect(rows.map((r) => r.id).sort()).toEqual(["free", "free2", "paid"]);
  });
});
