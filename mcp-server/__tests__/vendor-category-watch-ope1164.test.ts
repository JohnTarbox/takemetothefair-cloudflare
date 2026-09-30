/**
 * OPE-1164 step 5 — the weekly watch on new vendor category values.
 *
 * Acceptance: "a forced test in which a new value appears and the alert fires",
 * and the values themselves are recorded, not just a count.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, type TestDb } from "./setup-db.js";
import type { Db } from "../src/db.js";
import {
  formatWatchSection,
  readLatestWatch,
  runVendorCategoryWatch,
  watchVendorCategoriesOnce,
} from "../src/vendor-category-watch.js";

let db: TestDb;
let raw: Database.Database;
beforeEach(() => {
  ({ db, raw } = createTestDb());
});

let n = 0;
function vendor(type: string | null, sells: string | null = null) {
  const id = `v${++n}`;
  raw
    .prepare(`INSERT INTO users (id, email, role) VALUES (?, ?, 'VENDOR')`)
    .run(`u${id}`, `${id}@example.com`);
  raw
    .prepare(
      `INSERT INTO vendors (id, user_id, business_name, slug, vendor_type, sells_category) VALUES (?,?,?,?,?,?)`
    )
    .run(id, `u${id}`, `Biz ${id}`, id, type, sells);
}
const MON1 = new Date("2026-09-28T07:00:00Z"); // a Monday
const MON2 = new Date("2026-10-05T07:00:00Z");
const TUE = new Date("2026-09-29T07:00:00Z");

describe("watchVendorCategoriesOnce", () => {
  it("the first run is a BASELINE: records everything, reports nothing as new", async () => {
    vendor("Crafts");
    vendor("Jewelry", "Jewelry");
    const res = await watchVendorCategoriesOnce(db as unknown as Db, MON1);
    expect(res.map((r) => [r.field, r.baseline, r.newValues.length])).toEqual([
      ["vendor_type", true, 0],
      ["sells_category", true, 0],
      ["business_sector", true, 0],
      ["vendor_identity", true, 0],
    ]);
    expect(res.every((r) => !r.fired)).toBe(true);
    const seen = raw
      .prepare(`SELECT field, value, baseline FROM vendor_category_values ORDER BY 1,2`)
      .all();
    expect(seen).toEqual([
      { field: "sells_category", value: "Jewelry", baseline: 1 },
      { field: "vendor_type", value: "Crafts", baseline: 1 },
      { field: "vendor_type", value: "Jewelry", baseline: 1 },
    ]);
  });

  it("FORCED: a new value in a new field fires (threshold 0), with the value named", async () => {
    vendor("Crafts");
    await watchVendorCategoriesOnce(db as unknown as Db, MON1);
    vendor("Crafts", "Hot Sauce");
    const res = await watchVendorCategoriesOnce(db as unknown as Db, MON2);
    const sells = res.find((r) => r.field === "sells_category")!;
    expect(sells).toMatchObject({
      baseline: false,
      newValues: ["Hot Sauce"],
      threshold: 0,
      fired: true,
    });
    const run = raw
      .prepare(
        `SELECT new_count, new_values, fired FROM vendor_category_watch_runs WHERE field='sells_category' AND run_at = ?`
      )
      .get(Math.floor(MON2.getTime() / 1000));
    expect(run).toEqual({ new_count: 1, new_values: '["Hot Sauce"]', fired: 1 });
  });

  it("vendor_type alerts only ABOVE its threshold (default 5), and the threshold is tunable", async () => {
    vendor("Crafts");
    await watchVendorCategoriesOnce(db as unknown as Db, MON1);
    for (const t of ["A1", "A2", "A3", "A4", "A5"]) vendor(t);
    let vt = (await watchVendorCategoriesOnce(db as unknown as Db, MON2)).find(
      (r) => r.field === "vendor_type"
    )!;
    expect(vt).toMatchObject({
      newValues: ["A1", "A2", "A3", "A4", "A5"],
      threshold: 5,
      fired: false,
    });

    raw
      .prepare(
        `INSERT INTO tunable_thresholds (key, value, unit, updated_at) VALUES ('vendor_category_new_vendor_type_max', 0, 'values', 0)`
      )
      .run();
    vendor("A6");
    vt = (
      await watchVendorCategoriesOnce(db as unknown as Db, new Date("2026-10-12T07:00:00Z"))
    ).find((r) => r.field === "vendor_type")!;
    expect(vt).toMatchObject({ newValues: ["A6"], threshold: 0, fired: true });
  });

  it("a value seen before is never new again", async () => {
    vendor("Crafts");
    await watchVendorCategoriesOnce(db as unknown as Db, MON1);
    vendor("Crafts");
    const vt = (await watchVendorCategoriesOnce(db as unknown as Db, MON2)).find(
      (r) => r.field === "vendor_type"
    )!;
    expect(vt.newValues).toEqual([]);
  });
});

describe("runVendorCategoryWatch — Monday only, once per Monday", () => {
  it("skips a Tuesday, runs a Monday, and skips a second Monday call", async () => {
    vendor("Crafts");
    expect(await runVendorCategoryWatch(db as unknown as Db, TUE)).toBeNull();
    expect(await runVendorCategoryWatch(db as unknown as Db, MON1)).not.toBeNull();
    expect(
      await runVendorCategoryWatch(db as unknown as Db, new Date("2026-09-28T19:00:00Z"))
    ).toBeNull();
  });
});

describe("the Monday email section", () => {
  it("names the new values and flags the fired fields", async () => {
    vendor("Crafts");
    await watchVendorCategoriesOnce(db as unknown as Db, MON1);
    vendor("Kombucha", "Hot Sauce");
    await watchVendorCategoriesOnce(db as unknown as Db, MON2);
    const text = formatWatchSection(await readLatestWatch(db as unknown as Db));
    expect(text).toContain("⚠️ sells_category: 1 new (alert above 0) — Hot Sauce");
    expect(text).toContain("vendor_type: 1 new (alert above 5) — Kombucha");
    expect(text).not.toContain("⚠️ vendor_type");
  });
});
