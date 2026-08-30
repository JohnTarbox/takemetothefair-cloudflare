/**
 * OPE-647 — a vendor could not find her own listing.
 *
 * `aéhkō` (slug `aehko`) was created by its owner at signup, fully populated,
 * `claimed=1`, completeness 100. Sixteen minutes later she searched `aehko` on
 * our site and got **0 results**, concluded the profile was broken, and emailed
 * support. Her data was never lost — only unfindable by the spelling her
 * keyboard produces.
 *
 * SQLite cannot fix this on the stored side: its `LIKE`, `lower()` and
 * `upper()` are ASCII-only, so `é`/`ō` never fold. A test that leaned on
 * `lower()` would pass while the bug stayed. The bridge is `slug`, which
 * already stores the transliterated form — so the QUERY is folded through the
 * same `createSlug` and matched against it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/schema.js";
import { vendors } from "../src/schema.js";
import { vendorSearchWhere } from "../src/helpers.js";
import { searchSlugForm } from "@takemetothefair/utils";

const SCHEMA_SQL = `
  CREATE TABLE vendors (
    id TEXT PRIMARY KEY, business_name TEXT NOT NULL, display_name TEXT,
    slug TEXT NOT NULL UNIQUE, vendor_type TEXT,
    verified INTEGER DEFAULT 0, deleted_at INTEGER
  );
`;

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

function seed(id: string, name: string, slug: string, opts: { deleted?: boolean } = {}) {
  raw
    .prepare(
      `INSERT INTO vendors (id, business_name, slug, vendor_type, verified, deleted_at)
       VALUES (?,?,?,?,0,?)`
    )
    .run(id, name, slug, "crafts", opts.deleted ? 1_700_000_000 : null);
}

const search = (params: Parameters<typeof vendorSearchWhere>[0]) =>
  db
    .select({ id: vendors.id, name: vendors.businessName })
    .from(vendors)
    .where(vendorSearchWhere(params));

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  seed("aehko", "aéhkō", "aehko");
  seed("cafe", "Café Crème", "cafe-creme");
  seed("plain", "Plain Crafts", "plain-crafts");
});

describe("the customer's own search finds her listing", () => {
  it("finds aéhkō by the ASCII spelling — the reported 0-result case", async () => {
    expect((await search({ query: "aehko" })).map((r) => r.id)).toEqual(["aehko"]);
  });

  it("still finds it by the accented spelling", async () => {
    expect((await search({ query: "aéhkō" })).map((r) => r.id)).toEqual(["aehko"]);
  });

  it("is case-insensitive across both spellings", async () => {
    expect((await search({ query: "AEHKO" })).map((r) => r.id)).toEqual(["aehko"]);
    expect((await search({ query: "AÉHKŌ" })).map((r) => r.id)).toEqual(["aehko"]);
  });

  it("handles a MULTI-WORD accented name", async () => {
    // Both sides go through the same slugifier, so "Cafe Creme" -> "cafe-creme"
    // matches the stored slug. A raw diacritic-fold would yield "cafe creme"
    // and miss the dash.
    expect((await search({ query: "Cafe Creme" })).map((r) => r.id)).toEqual(["cafe"]);
    expect((await search({ query: "Café Crème" })).map((r) => r.id)).toEqual(["cafe"]);
  });
});

describe("the bridge does not widen the net", () => {
  it("does not match an unrelated vendor", async () => {
    expect(await search({ query: "aehko" })).toHaveLength(1);
  });

  it("returns nothing for a punctuation-only query rather than everything", async () => {
    // searchSlugForm returns null, and the clause must be OMITTED — not
    // included as an empty-string `instr`, which matches every row.
    expect(searchSlugForm("!!!")).toBeNull();
    expect(await search({ query: "!!!" })).toHaveLength(0);
  });

  it("keeps plain-ASCII matching unchanged", async () => {
    expect((await search({ query: "Plain" })).map((r) => r.id)).toEqual(["plain"]);
  });
});

describe("no regression to the sibling filters on this clause", () => {
  it("still excludes merge tombstones (OPE-566)", async () => {
    seed("dead", "aéhkō Old", "aehko-old", { deleted: true });
    expect((await search({ query: "aehko" })).map((r) => r.id)).toEqual(["aehko"]);
  });

  it("still honours verified_only (OPE-632)", async () => {
    // The diacritic match must not smuggle an unverified row past the filter.
    expect(await search({ query: "aehko", verified_only: true })).toHaveLength(0);
  });
});
