/**
 * OPE-1113 — one spelling per vendor category (John's ruling, 2026-09-25):
 * merge values that differ only by case, surrounding whitespace, or a plain
 * plural, plus the two named pairs; keep different WORDS apart ("Fine Craft"
 * is not "Craft").
 *
 * The DB cases read the stored row back after the call — the acceptance is
 * about what is STORED, not what a function returns.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@takemetothefair/db-schema";
import {
  createOrLinkVendor,
  pickVendorTypeSpelling,
  resolveVendorTypeForWrite,
  sameVendorType,
  vendorTypeFoldKey,
} from "@takemetothefair/vendor-linking";

describe("the rule (pure)", () => {
  it.each([
    ["Crafts", "Craft"],
    ["crafts ", "Crafts"],
    ["Specialty Foods", "specialty food"],
    ["Food  Truck", "food truck"],
    ["Ceramic", "ceramics"],
    ["Building Supplies", "Building Supply"],
    ["Non-Profit", "Nonprofit"],
    ["woodwork", "Woodworking"],
  ])("%j and %j are the same category", (a, b) => {
    expect(sameVendorType(a, b)).toBe(true);
  });

  it.each([
    ["Fine Craft", "Craft"],
    ["Fine Craft", "Crafts"],
    ["Art", "Artist"],
    ["Art", "Fine Art"],
    ["Fiber", "Fiber Arts"],
    ["Marine", "Marine Services"],
    ["Beverage", "Beverage Distributor"],
    ["Glass", "Glas"],
  ])("%j and %j stay DIFFERENT (John's ruling: different words)", (a, b) => {
    expect(sameVendorType(a, b)).toBe(false);
  });

  it("folds -ies and -s but never -ss", () => {
    expect(vendorTypeFoldKey("Supplies")).toBe("supply");
    expect(vendorTypeFoldKey("Glass")).toBe("glass");
  });

  it("picks the most-used spelling; ties go capitalised, then plural", () => {
    const rows = [
      { value: "Craft", count: 62 },
      { value: "Crafts", count: 331 },
      { value: "Fine Craft", count: 22 },
    ];
    expect(pickVendorTypeSpelling("craft", rows)).toBe("Crafts");
    expect(pickVendorTypeSpelling("Fine craft", rows)).toBe("Fine Craft");
    expect(
      pickVendorTypeSpelling("x", [
        { value: "legal services", count: 3 },
        { value: "Legal Services", count: 3 },
      ])
    ).toBe("x");
    expect(
      pickVendorTypeSpelling("legal service", [
        { value: "legal services", count: 3 },
        { value: "Legal Services", count: 3 },
      ])
    ).toBe("Legal Services");
    expect(
      pickVendorTypeSpelling("pet", [
        { value: "Pet", count: 2 },
        { value: "Pets", count: 2 },
      ])
    ).toBe("Pets");
  });

  it("an unknown category is stored as typed (squashed), and a named alias as its target", () => {
    expect(pickVendorTypeSpelling("  Llama   Wool ", [])).toBe("Llama Wool");
    expect(pickVendorTypeSpelling("Non-Profit", [])).toBe("Nonprofit");
  });
});

// ── Against a DB: what is STORED ─────────────────────────────────────────────
// The DDL is the OPE-714 test's, read from that file so the two cannot drift.
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
});

let n = 0;
function seedVendor(name: string, type: string | null) {
  const id = `v${++n}`;
  raw
    .prepare(`INSERT INTO users (id, email, origin) VALUES (?,?,?)`)
    .run(`u-${id}`, `pending+${id}@meetmeatthefair.com`, "ingestion");
  raw
    .prepare(
      `INSERT INTO vendors (id, user_id, business_name, slug, vendor_type) VALUES (?,?,?,?,?)`
    )
    .run(id, `u-${id}`, name, id, type);
  return id;
}
function seedTypes() {
  for (let i = 0; i < 5; i++) seedVendor(`Crafter ${i}`, "Crafts");
  seedVendor("Solo", "Craft");
  seedVendor("Finer", "Fine Craft");
  for (let i = 0; i < 3; i++) seedVendor(`Charity ${i}`, "Nonprofit");
}
const storedType = (businessName: string) =>
  (
    raw.prepare(`SELECT vendor_type FROM vendors WHERE business_name = ?`).get(businessName) as {
      vendor_type: string | null;
    }
  ).vendor_type;

describe("resolveVendorTypeForWrite", () => {
  it("resolves to the stored spelling of the same category", async () => {
    seedTypes();
    expect(await resolveVendorTypeForWrite(db, "crafts ")).toBe("Crafts");
    expect(await resolveVendorTypeForWrite(db, "CRAFT")).toBe("Crafts");
    expect(await resolveVendorTypeForWrite(db, "fine craft")).toBe("Fine Craft");
    expect(await resolveVendorTypeForWrite(db, "Non-profit")).toBe("Nonprofit");
    expect(await resolveVendorTypeForWrite(db, "Llama Wool")).toBe("Llama Wool");
    expect(await resolveVendorTypeForWrite(db, "   ")).toBeNull();
    expect(await resolveVendorTypeForWrite(db, null)).toBeNull();
  });
});

describe("create_or_link_vendor — the acceptance, read back from the row", () => {
  beforeEach(() => {
    raw
      .prepare(`INSERT INTO events (id, slug, name, source_url) VALUES ('e1','e1','E1',NULL)`)
      .run();
  });

  it('a new vendor with vendor_type "crafts " stores "Crafts"', async () => {
    seedTypes();
    const res = await createOrLinkVendor(
      db,
      { eventId: "e1", businessName: "Brand New Maker", type: "crafts ", dedupStrategy: "skip" },
      deps
    );
    expect(res.ok).toBe(true);
    expect(storedType("Brand New Maker")).toBe("Crafts");
  });

  it('a new vendor with vendor_type "Fine Craft" stores "Fine Craft"', async () => {
    seedTypes();
    await createOrLinkVendor(
      db,
      { eventId: "e1", businessName: "Another Maker", type: "Fine Craft", dedupStrategy: "skip" },
      deps
    );
    expect(storedType("Another Maker")).toBe("Fine Craft");
  });

  it("a case/plural-only difference on a matched vendor is NOT staged as a disagreement", async () => {
    seedVendor("Acme Pottery", "Crafts");
    await createOrLinkVendor(
      db,
      { eventId: "e1", businessName: "Acme Pottery", type: "craft" },
      deps
    );
    expect(raw.prepare(`SELECT COUNT(*) c FROM vendor_enrichment_candidates`).get()).toEqual({
      c: 0,
    });
  });

  it("a matched vendor still holding a stray spelling is not staged either", async () => {
    // "crafts" on the row, "Crafts" everywhere else: the incoming value resolves
    // to "Crafts", which differs from the row only by case.
    seedTypes();
    seedVendor("Stray Case Co", "crafts");
    await createOrLinkVendor(
      db,
      { eventId: "e1", businessName: "Stray Case Co", type: "Crafts" },
      deps
    );
    expect(raw.prepare(`SELECT COUNT(*) c FROM vendor_enrichment_candidates`).get()).toEqual({
      c: 0,
    });
  });

  it("Fine Craft vs Craft on a matched vendor IS still staged (John ruled them different)", async () => {
    seedVendor("Acme Weaving", "Fine Craft");
    await createOrLinkVendor(
      db,
      { eventId: "e1", businessName: "Acme Weaving", type: "Craft" },
      deps
    );
    const rows = raw
      .prepare(`SELECT current_value, proposed_value FROM vendor_enrichment_candidates`)
      .all();
    expect(rows).toEqual([{ current_value: "Fine Craft", proposed_value: "Craft" }]);
  });
});

// ── Structural guard: keyed on the ACT (writing a raw request value into
// vendorType), not on the fix — so a NEW writer that skips the resolver fails
// here even though nobody listed it. Client form state (src/app/**/page.tsx)
// is not a write path and is not scanned.
import { readdirSync, statSync } from "node:fs";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

describe("every vendor_type writer goes through the resolver", () => {
  it("no server write path assigns a raw request value to vendorType", () => {
    const RAW_WRITE = /vendorType\s*[:=]\s*(params|data|input|body)\.(vendor_?[tT]ype|type)\b/;
    const roots = ["src/app/api", "mcp-server/src", "packages"].map((r) => join(process.cwd(), r));
    const offenders = roots
      .flatMap((r) => walk(r))
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .map((line, i) => ({ f, i: i + 1, line }))
          .filter(({ line }) => RAW_WRITE.test(line))
      )
      .map(({ f, i, line }) => `${f.replace(process.cwd() + "/", "")}:${i}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });
});
