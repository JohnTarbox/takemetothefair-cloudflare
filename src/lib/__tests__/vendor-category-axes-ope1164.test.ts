/**
 * OPE-1164 steps 1–2 — three category axes, and a description is never a
 * category: it goes to `products`. Read back from the stored row.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@takemetothefair/db-schema";
import {
  createOrLinkVendor,
  isDescriptiveVendorType,
  mergeProductsJson,
  routeVendorCategoriesForWrite,
} from "@takemetothefair/vendor-linking";

describe("isDescriptiveVendorType (pure)", () => {
  it.each(["Crafts", "Fine Craft", "Specialty Food", "Bath & Body / Soap", "Arts and crafts"])(
    "%j is a category",
    (v) => expect(isDescriptiveVendorType(v)).toBe(false)
  );
  it.each([
    "hand-turned wooden bowls and cutting boards",
    "Pottery, mugs, bowls",
    "We make small-batch soap.",
    "Handmade jewelry (sterling)",
  ])("%j is a description", (v) => expect(isDescriptiveVendorType(v)).toBe(true));
});

describe("mergeProductsJson (pure)", () => {
  it("appends, de-duplicates case-insensitively, and repairs malformed JSON", () => {
    expect(mergeProductsJson('["mugs"]', ["Bowls", "MUGS"])).toBe('["mugs","Bowls"]');
    expect(mergeProductsJson("not json", ["bowls"])).toBe('["bowls"]');
    expect(mergeProductsJson(null, [])).toBe("[]");
  });
});

const ope714 = readFileSync(
  join(process.cwd(), "src/lib/__tests__/vendor-type-disagreement-ope714.test.ts"),
  "utf8"
);
const SCHEMA_SQL = /const SCHEMA_SQL = `([\s\S]*?)`;/.exec(ope714)![1];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;
const deps = {
  actorUserId: null,
  recomputeVendorCompleteness: async () => undefined,
  logEnrichment: async () => undefined,
};
beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
  raw.prepare(`INSERT INTO events (id, slug, name, source_url) VALUES ('e1','e1','E1',NULL)`).run();
});
const row = (name: string) =>
  raw
    .prepare(
      `SELECT vendor_type, sells_category, business_sector, vendor_identity, products FROM vendors WHERE business_name = ?`
    )
    .get(name) as Record<string, string | null>;
const distinctTypes = () =>
  (
    raw
      .prepare(`SELECT COUNT(DISTINCT vendor_type) c FROM vendors WHERE vendor_type IS NOT NULL`)
      .get() as { c: number }
  ).c;

describe("create_or_link_vendor — the acceptance, read back", () => {
  it("a long free-text type lands in products and NO new category value appears", async () => {
    const before = distinctTypes();
    const res = await createOrLinkVendor(
      db,
      {
        eventId: "e1",
        businessName: "Turner Woodshop",
        type: "hand-turned wooden bowls and cutting boards",
        products: ["spoons"],
        dedupStrategy: "skip",
      },
      deps
    );
    expect(res.ok).toBe(true);
    const r = row("Turner Woodshop");
    expect(r.vendor_type).toBeNull();
    expect(JSON.parse(r.products as string)).toEqual([
      "spoons",
      "hand-turned wooden bowls and cutting boards",
    ]);
    expect(distinctTypes()).toBe(before);
  });

  it("sets all three axes on create", async () => {
    await createOrLinkVendor(
      db,
      {
        eventId: "e1",
        businessName: "Harbor Brewing",
        type: "Brewery",
        sellsCategory: "Beer",
        businessSector: "Brewery",
        vendorIdentity: "Business",
        dedupStrategy: "skip",
      },
      deps
    );
    expect(row("Harbor Brewing")).toMatchObject({
      vendor_type: "Brewery",
      sells_category: "Beer",
      business_sector: "Brewery",
      vendor_identity: "Business",
    });
  });

  it("a description sent as an AXIS also goes to products, not the axis", async () => {
    await createOrLinkVendor(
      db,
      {
        eventId: "e1",
        businessName: "Maple Farm",
        sellsCategory: "maple syrup, candy, and cream in small batches",
        dedupStrategy: "skip",
      },
      deps
    );
    const r = row("Maple Farm");
    expect(r.sells_category).toBeNull();
    expect(JSON.parse(r.products as string)).toContain(
      "maple syrup, candy, and cream in small batches"
    );
  });

  it("a descriptive value that IS already an existing category is kept (old data is not rewritten)", async () => {
    raw.prepare(`INSERT INTO users (id, email, origin) VALUES ('u-x','x@e.com','ingestion')`).run();
    raw
      .prepare(
        `INSERT INTO vendors (id, user_id, business_name, slug, vendor_type) VALUES ('x','u-x','Old','old',?)`
      )
      .run("Home, Garden & Patio");
    const r = await routeVendorCategoriesForWrite(db, { vendorType: "Home, Garden & Patio" });
    expect(r).toEqual({ values: { vendorType: "Home, Garden & Patio" }, productsToAdd: [] });
  });
});

// ── Every writer in scope (2) routes through the category router ─────────────
describe("every category writer goes through the router (can set the axes)", () => {
  it.each([
    ["packages/vendor-linking/src/index.ts", "routeVendorCategoriesForWrite("],
    ["mcp-server/src/tools/admin.ts", "routeVendorCategoriesForWrite("],
    ["mcp-server/src/tools/admin-create-or-link-vendor.ts", "sellsCategory: params.sells_category"],
    ["mcp-server/src/tools/admin-enrichment-review.ts", "routeVendorTypeForWrite("],
    ["mcp-server/src/tools/vendor.ts", "routeVendorTypeForWrite("],
    ["src/app/api/admin/vendors/route.ts", "routeVendorCategoriesForWrite("],
    ["src/app/api/admin/vendors/[id]/route.ts", "routeVendorCategoriesForWrite("],
    ["src/app/api/vendor/profile/route.ts", "routeVendorCategoriesForWrite("],
  ])("%s", (f, marker) => {
    expect(readFileSync(join(process.cwd(), f), "utf8")).toContain(marker);
  });
});
