/**
 * OPE-1395 (IDX4) — /api/search carries a short browser cache, but only on a
 * complete response, and only because the handler reads nothing user-specific.
 *
 * Runs the real route against an in-memory SQLite with the tables it queries.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "@/lib/db/schema";

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => harness.db }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => undefined) }));

import { GET } from "../search/route";

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

let raw: InstanceType<typeof Database>;

beforeEach(() => {
  raw = new Database(":memory:");
  for (const t of [
    schema.events,
    schema.venues,
    schema.vendors,
    schema.blogPosts,
    schema.venueNameVariants,
    schema.eventNameVariants,
  ]) {
    raw.exec(ddlFor(t));
  }
  raw
    .prepare(
      "INSERT INTO vendors (id, user_id, business_name, slug, role) VALUES ('v1', 'u1', 'Maple Candy Co', 'maple-candy-co', 'INDEPENDENT')"
    )
    .run();
  harness.db = drizzle(raw, { schema });
});

const call = (q: string) =>
  GET(new Request(`http://localhost/api/search?q=${encodeURIComponent(q)}`), {
    params: Promise.resolve({}),
  });

describe("OPE-1395 — /api/search Cache-Control", () => {
  it("a complete result is browser-cacheable for 60s", async () => {
    const res = await call("maple");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vendors: { slug: string }[] };
    expect(body.vendors.map((v) => v.slug)).toEqual(["maple-candy-co"]); // landmark: real query ran
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  it("a degraded result (a section failed and came back empty) is NOT cached", async () => {
    raw.exec("DROP TABLE blog_posts");
    const res = await call("maple");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("the handler reads no session, cookie or header state (the premise of caching it)", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/search/route.ts"), "utf8");
    for (const call of ["auth(", "cookies(", "headers(", "getServerSession(", "getToken("]) {
      expect(src, call).not.toContain(call);
    }
  });
});
