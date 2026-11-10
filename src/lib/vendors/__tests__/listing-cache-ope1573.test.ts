/**
 * OPE-1573 — /vendors facet-crawl fixes:
 *   1. kvReadThrough (src/lib/kv-read-through.ts) caches URL-independent reads
 *      and fails open in every direction except a loader error.
 *   2. filterFeaturedByType keeps the SQL's exact-match semantics.
 *   3. drizzle/0394 turns the `?type=` listing read into a seek on vendor_type.
 */
import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, eq, isNull } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { vendors } from "../../db/schema";
import { kvReadThrough, type ReadThroughKv } from "../../kv-read-through";
import {
  FEATURED_VENDORS_CACHE_KEY,
  VENDOR_LISTING_CACHE_TTL_SECONDS,
  VENDOR_TYPES_CACHE_KEY,
  filterFeaturedByType,
} from "../listing-cache";

function memoryKv() {
  const store = new Map<string, string>();
  const puts: Array<{ key: string; ttl?: number }> = [];
  const kv: ReadThroughKv = {
    async get(key) {
      const v = store.get(key);
      return v === undefined ? null : JSON.parse(v);
    },
    async put(key, value, opts) {
      puts.push({ key, ttl: opts?.expirationTtl });
      store.set(key, value);
    },
  };
  return { kv, store, puts };
}

describe("kvReadThrough", () => {
  it("miss → runs the loader once and stores the value with the TTL; hit → loader not called", async () => {
    const { kv, puts } = memoryKv();
    const loader = vi.fn(async () => ["Art", "Crafts"]);
    expect(await kvReadThrough(kv, "k", 3600, loader)).toEqual(["Art", "Crafts"]);
    expect(await kvReadThrough(kv, "k", 3600, loader)).toEqual(["Art", "Crafts"]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(puts).toEqual([{ key: "k", ttl: 3600 }]);
  });

  it("caches an empty array as a hit (an empty featured set is a real answer)", async () => {
    const { kv } = memoryKv();
    const loader = vi.fn(async () => [] as string[]);
    await kvReadThrough(kv, "k", 3600, loader);
    await kvReadThrough(kv, "k", 3600, loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("clamps the TTL to KV's 60s floor", async () => {
    const { kv, puts } = memoryKv();
    await kvReadThrough(kv, "k", 5, async () => 1);
    expect(puts[0].ttl).toBe(60);
  });

  it("no binding → loader result, nothing cached", async () => {
    const loader = vi.fn(async () => 42);
    expect(await kvReadThrough(null, "k", 3600, loader)).toBe(42);
    expect(await kvReadThrough(undefined, "k", 3600, loader)).toBe(42);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("fails open when KV get or put throws", async () => {
    const broken: ReadThroughKv = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {
        throw new Error("kv down");
      },
    };
    expect(await kvReadThrough(broken, "k", 3600, async () => "fresh")).toBe("fresh");
  });

  it("propagates a loader error and caches nothing", async () => {
    const { kv, puts } = memoryKv();
    await expect(
      kvReadThrough(kv, "k", 3600, async () => {
        throw new Error("D1 overloaded");
      })
    ).rejects.toThrow("D1 overloaded");
    expect(puts).toEqual([]);
  });
});

describe("listing-cache constants + featured filter", () => {
  it("uses distinct versioned keys and a ~1h TTL", () => {
    expect(VENDOR_TYPES_CACHE_KEY).not.toBe(FEATURED_VENDORS_CACHE_KEY);
    expect(VENDOR_TYPES_CACHE_KEY).toMatch(/:v\d+$/);
    expect(FEATURED_VENDORS_CACHE_KEY).toMatch(/:v\d+$/);
    expect(VENDOR_LISTING_CACHE_TTL_SECONDS).toBe(3600);
  });

  it("filters exactly like `vendor_type = ?` (exact, case-sensitive); no filter → all", () => {
    const all = [
      { id: "a", vendorType: "Crafts" },
      { id: "b", vendorType: "crafts" },
      { id: "c", vendorType: null },
      { id: "d", vendorType: "Fine Arts & Crafts" },
    ];
    expect(filterFeaturedByType(all, "Crafts").map((v) => v.id)).toEqual(["a"]);
    expect(filterFeaturedByType(all, undefined)).toBe(all);
    expect(filterFeaturedByType(all, "")).toBe(all);
    expect(filterFeaturedByType(all, "Nope")).toEqual([]);
  });
});

describe("drizzle/0394 vendors(vendor_type, deleted_at, business_name) index", () => {
  it("turns the ?type= listing read from a deleted_at-only search into a vendor_type seek", () => {
    const raw = new Database(":memory:");
    const cfg = getTableConfig(vendors);
    raw.exec(
      `CREATE TABLE vendors (${cfg.columns.map((c) => `${c.name} ${c.primary ? "TEXT PRIMARY KEY" : "TEXT"}`).join(", ")});`
    );
    // The index prod already has (drizzle/0374).
    raw.exec(
      "CREATE INDEX idx_vendors_deleted_business_name ON vendors(deleted_at, business_name);"
    );
    const db = drizzle(raw);
    // Same WHERE + ORDER BY as loadVendorListingPage's match-set read.
    const q = db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(isNull(vendors.deletedAt), eq(vendors.vendorType, "Wood Carving")))
      .orderBy(vendors.businessName)
      .toSQL();
    const plan = () =>
      (raw.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params) as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join(" | ");

    // Before: matches prod's measured plan (driven to failure — not vacuous).
    expect(plan()).toMatch(/idx_vendors_deleted_business_name \(deleted_at=\?\)/);

    const sqlText = readFileSync(
      join(__dirname, "../../../../drizzle/0394_ope1573_vendors_type_listing_index.sql"),
      "utf8"
    );
    raw.exec(sqlText);
    raw.exec(sqlText); // idempotent

    const after = plan();
    expect(after).toMatch(
      /SEARCH vendors USING INDEX idx_vendors_type_deleted_business_name \(vendor_type=\? AND deleted_at=\?\)/
    );
    expect(after).not.toMatch(/TEMP B-TREE/);
  });
});
