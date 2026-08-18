/**
 * OPE-451 — the vendor dedup that was creating the duplicates it existed to
 * prevent. Found live during a 60-vendor roster backfill on 2026-08-17.
 *
 * Two defects, both confirmed at source before being rewritten (the ticket
 * filed them as black-box observations and asked for that check):
 *
 *  (a) `fuzzy` scored `getVendorComparisonString`, which appended `vendorType`
 *      to the name. "Salvage Sistas" existed as `Maker`; the roster supplied
 *      `Baby/Child`; the names were BYTE-IDENTICAL and it still missed.
 *
 *  (b) `strict` was `eq(businessName, ?)` — raw and case-SENSITIVE — while its
 *      own tool doc promised "case-insensitive exact match". "Time to Be Candle
 *      Company" vs "Time To Be Candle Company": one capital letter, one
 *      duplicate row.
 *
 * These run against real in-memory SQLite because defect (b) lived in the SQL.
 * A pure-function test would have asserted the normalizer works — which it
 * already did — and sailed straight past the missing `lower()`.
 *
 * Both are structurally hostile to the roster-backfill workload specifically,
 * which is where most vendors come from: a backfill assigns every exhibitor the
 * SHOW's category while the existing row carries whatever a previous pass
 * assigned, so category disagreement is the normal case.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@takemetothefair/db-schema";
import { findStrictMatch, findFuzzyMatch } from "@takemetothefair/vendor-linking";

const SCHEMA_SQL = `
  CREATE TABLE vendors (
    id TEXT PRIMARY KEY,
    business_name TEXT NOT NULL,
    slug TEXT,
    vendor_type TEXT,
    redirect_to_vendor_id TEXT,
    deleted_at INTEGER
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

function seed(id: string, businessName: string, vendorType: string | null = null) {
  raw
    .prepare(`INSERT INTO vendors (id, business_name, slug, vendor_type) VALUES (?,?,?,?)`)
    .run(id, businessName, id, vendorType);
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("(a) fuzzy must not let a category disagreement veto an exact name", () => {
  it("matches Salvage Sistas across Maker → Baby/Child", async () => {
    seed("4e1032cb", "Salvage Sistas", "Maker");
    const hit = await findFuzzyMatch(db, "Salvage Sistas", "Baby/Child");
    expect(hit?.row.id).toBe("4e1032cb");
    expect(hit?.score).toBe(1); // identical names score 1, whatever the types
  });

  it("matches when the incoming vendor has no type at all", async () => {
    seed("v1", "Salvage Sistas", "Maker");
    expect((await findFuzzyMatch(db, "Salvage Sistas", null))?.row.id).toBe("v1");
  });

  it("matches when the EXISTING row has no type", async () => {
    seed("v1", "Salvage Sistas", null);
    expect((await findFuzzyMatch(db, "Salvage Sistas", "Baby/Child"))?.row.id).toBe("v1");
  });

  it("still refuses two genuinely different businesses that share a word", async () => {
    // Dropping type from the score must not turn fuzzy into a word-match. If
    // this ever passes, the ≥0.92 threshold has been lost.
    seed("v1", "Portland Pottery Studio", "Maker");
    expect(await findFuzzyMatch(db, "Portland Cider Company", "Food")).toBeNull();
  });
});

describe("(b) strict must be case-insensitive, as documented", () => {
  it("matches the reported pair — one capital letter apart", async () => {
    seed("fef9ca5f", "Time To Be Candle Company");
    const hit = await findStrictMatch(db, "Time to Be Candle Company");
    expect(hit?.id).toBe("fef9ca5f");
  });

  it("matches regardless of which side is upper-cased", async () => {
    seed("v1", "salvage sistas");
    expect((await findStrictMatch(db, "SALVAGE SISTAS"))?.id).toBe("v1");
  });

  it("still refuses a genuinely different name", async () => {
    seed("v1", "Time To Be Candle Company");
    expect(await findStrictMatch(db, "Time To Be Soap Company")).toBeNull();
  });
});

describe("(scope 4) strict normalizes punctuation and legal forms", () => {
  it("folds a trailing legal form — Co. vs Company", async () => {
    seed("2a58095e", "Center Street Soap Co.");
    expect((await findStrictMatch(db, "Center Street Soap Company"))?.id).toBe("2a58095e");
  });

  it("folds & against and", async () => {
    seed("v1", "Salt & Sage");
    expect((await findStrictMatch(db, "Salt and Sage"))?.id).toBe("v1");
  });

  it("folds an HTML entity — the shape an extracted roster page produces", async () => {
    seed("v1", "Salt & Sage");
    expect((await findStrictMatch(db, "Salt &amp; Sage"))?.id).toBe("v1");
  });

  it("folds the Unicode dash family", async () => {
    seed("v1", "Joie de Vivre - Studio");
    expect((await findStrictMatch(db, "Joie de Vivre — Studio"))?.id).toBe("v1");
  });

  it("does NOT fold two different names into one", async () => {
    // Normalization must not become a similarity match by the back door:
    // strict still means the SAME name.
    seed("v1", "Little Cat Metals");
    expect(await findStrictMatch(db, "Little Cat Ceramics")).toBeNull();
  });
});

describe("rows that must never match", () => {
  it("ignores soft-deleted vendors on strict", async () => {
    seed("gone", "Salvage Sistas");
    raw.prepare(`UPDATE vendors SET deleted_at = 1 WHERE id='gone'`).run();
    expect(await findStrictMatch(db, "salvage sistas")).toBeNull();
  });

  it("ignores soft-deleted vendors on fuzzy", async () => {
    seed("gone", "Salvage Sistas", "Maker");
    raw.prepare(`UPDATE vendors SET deleted_at = 1 WHERE id='gone'`).run();
    expect(await findFuzzyMatch(db, "Salvage Sistas", "Baby/Child")).toBeNull();
  });
});

describe("determinism", () => {
  it("strict returns the same row every time when duplicates already exist", async () => {
    // The catalog already contains duplicate pairs this bug created, so a
    // backfill re-run WILL hit two matching rows. Picking arbitrarily would
    // link one event to one row and the next to the other, compounding the
    // mess; lowest id is stable.
    seed("bbbb", "Judy Plank Art");
    seed("aaaa", "judy plank art");
    const first = await findStrictMatch(db, "Judy Plank ART");
    const second = await findStrictMatch(db, "JUDY PLANK art");
    expect(first?.id).toBe(second?.id);
  });
});
