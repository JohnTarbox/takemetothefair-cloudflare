/**
 * OPE-1597 — the full-table sweep: blocking, the stored run, the cut-over, and
 * the probe that says the job still runs for every type.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "@/lib/db/schema";
import { HEARTBEAT_PROBES } from "@/lib/heartbeat";
import {
  blockKey,
  loadStoredDuplicates,
  planBlockedPairs,
  runFullDuplicateSweep,
  type SweepRow,
} from "../full-sweep";

const r = (id: string, name: string, exactKey?: string): SweepRow => ({
  id,
  blockName: name,
  compare: name.toLowerCase(),
  exactKey,
});

describe("blockKey", () => {
  it("ignores a leading article, so 'The X' and 'X' share a block", () => {
    expect(blockKey("The Maine Ingredient")).toBe(blockKey("Maine Ingredient"));
    expect(blockKey("the")).toBe("the");
  });
  it("ignores punctuation and spacing", () => {
    expect(blockKey("A.B. Crafts")).toBe(blockKey("AB Crafts"));
  });
});

describe("planBlockedPairs", () => {
  it("finds the review's known duplicate and counts only in-block comparisons", () => {
    const { pairs, comparisons } = planBlockedPairs(
      [r("a", "12 Willows Press"), r("b", "12 Willows Press"), r("c", "Zebra Pottery")],
      0.6
    );
    expect(pairs).toEqual([{ entity1Id: "a", entity2Id: "b", similarity: 1 }]);
    expect(comparisons).toBe(1);
  });

  it("does not compare rows in different blocks", () => {
    expect(planBlockedPairs([r("a", "Apple Barn"), r("b", "Zebra Barn")], 0.1).comparisons).toBe(0);
  });

  it("pairs an exact identity whose names share no block, once", () => {
    const { pairs } = planBlockedPairs(
      [r("a", "Armory", "place-1"), r("b", "Zeb Hall", "place-1")],
      0.6
    );
    expect(pairs).toEqual([{ entity1Id: "a", entity2Id: "b", similarity: 0.99 }]);
  });

  it("does not double-count an exact pair that also shares a name block", () => {
    const { pairs } = planBlockedPairs(
      [r("a", "Armory Hall", "p"), r("b", "Armory Hall", "p")],
      0.6
    );
    expect(pairs).toHaveLength(1);
  });

  it("stays small on a vendor-sized table", () => {
    const rows = Array.from({ length: 14_000 }, (_, i) =>
      r(
        `v${i}`,
        `${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + (i % 7))}${i % 97} Farm Stand ${i}`
      )
    );
    const started = Date.now();
    const { comparisons } = planBlockedPairs(rows, 0.6);
    expect(comparisons).toBeLessThan(2_000_000);
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});

/** Every column the select() hydration reads, without restating the schema here. */
function typelessTable(table: Parameters<typeof getTableConfig>[0]): string {
  const { name, columns } = getTableConfig(table);
  return `CREATE TABLE ${name} (${columns.map((c) => `"${c.name}"`).join(", ")});`;
}

const DDL = `
${typelessTable(schema.vendors)}
${typelessTable(schema.eventVendors)}
CREATE TABLE entity_duplicate_sweep_runs (
  entity_type TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL, last_run_at INTEGER NOT NULL,
  checked_count INTEGER NOT NULL, live_count INTEGER NOT NULL, comparisons INTEGER NOT NULL,
  pair_count INTEGER NOT NULL, stored_pair_count INTEGER NOT NULL);
CREATE TABLE entity_duplicate_sweep_pairs (
  run_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity1_id TEXT NOT NULL,
  entity2_id TEXT NOT NULL, similarity REAL NOT NULL,
  PRIMARY KEY (run_id, entity1_id, entity2_id));
`;

describe("runFullDuplicateSweep (vendors)", () => {
  let raw: Database.Database;
  let db: never;
  const addVendor = (id: string, name: string, deleted = false) =>
    raw
      .prepare("INSERT INTO vendors (id, business_name, deleted_at) VALUES (?,?,?)")
      .run(id, name, deleted ? 1700000000 : null);

  beforeEach(() => {
    raw = new Database(":memory:");
    raw.exec(DDL);
    db = drizzle(raw, { schema }) as never;
  });

  it("ACCEPTANCE: checked equals live, and soft-deleted rows are not candidates", async () => {
    addVendor("a", "12 Willows Press");
    addVendor("b", "12 Willows Press");
    addVendor("gone", "12 Willows Press", true);
    addVendor("c", "Zebra Pottery");

    const result = await runFullDuplicateSweep(db, "vendors", { now: new Date(1_800_000_000_000) });
    expect(result.checkedCount).toBe(3);
    expect(result.liveCount).toBe(3);
    expect(result.pairCount).toBe(1);
  });

  it("a second run replaces the first and leaves no old pairs behind", async () => {
    addVendor("a", "12 Willows Press");
    addVendor("b", "12 Willows Press");
    await runFullDuplicateSweep(db, "vendors", { now: new Date(1_800_000_000_000) });
    raw.prepare("UPDATE vendors SET deleted_at = 1 WHERE id = 'b'").run();
    addVendor("x", "Maple Barn");
    addVendor("y", "Maple Barn");
    await runFullDuplicateSweep(db, "vendors", { now: new Date(1_800_000_100_000) });

    const rows = raw
      .prepare("SELECT entity1_id, entity2_id FROM entity_duplicate_sweep_pairs")
      .all();
    expect(rows).toEqual([{ entity1_id: "x", entity2_id: "y" }]);
  });

  it("the reader drops a pair merged since the run, and honours the threshold", async () => {
    addVendor("a", "12 Willows Press");
    addVendor("b", "12 Willows Press");
    await runFullDuplicateSweep(db, "vendors", { now: new Date(1_800_000_000_000) });

    const before = await loadStoredDuplicates(db, "vendors", 0.7);
    expect(before?.duplicates).toHaveLength(1);
    expect(before?.duplicates[0].entity1).toMatchObject({ id: "a", _count: { eventVendors: 0 } });

    raw.prepare("UPDATE vendors SET deleted_at = 1 WHERE id = 'a'").run();
    expect((await loadStoredDuplicates(db, "vendors", 0.7))?.duplicates).toEqual([]);
  });

  it("returns null when no run exists, so the page falls back to the on-demand search", async () => {
    expect(await loadStoredDuplicates(db, "vendors", 0.7)).toBeNull();
  });

  it("a short write does not publish the run", async () => {
    addVendor("a", "12 Willows Press");
    addVendor("b", "12 Willows Press");
    raw.exec(
      `CREATE TRIGGER drop_pairs AFTER INSERT ON entity_duplicate_sweep_pairs
       BEGIN DELETE FROM entity_duplicate_sweep_pairs; END;`
    );
    await expect(
      runFullDuplicateSweep(db, "vendors", { now: new Date(1_800_000_000_000) })
    ).rejects.toThrow(/run not published/);
    expect(raw.prepare("SELECT COUNT(*) n FROM entity_duplicate_sweep_runs").get()).toEqual({
      n: 0,
    });
  });
});

describe("probe entity-duplicate-full-sweep", () => {
  const probe = HEARTBEAT_PROBES.find((p) => p.name === "entity-duplicate-full-sweep")!;
  let raw: Database.Database;
  let db: never;
  const insert = (type: string, sec: number) =>
    raw
      .prepare(`INSERT INTO entity_duplicate_sweep_runs VALUES (?, 'r', ?, 1, 1, 0, 0, 0)`)
      .run(type, sec);

  beforeEach(() => {
    raw = new Database(":memory:");
    raw.exec(DDL);
    db = drizzle(raw, { schema }) as never;
  });

  it("no rows is no evidence", async () => {
    expect(await probe.lastEvidenceAt(db)).toBeNull();
  });

  it("three of four types is no evidence", async () => {
    ["venues", "events", "promoters"].forEach((t) => insert(t, 1_800_000_000));
    expect(await probe.lastEvidenceAt(db)).toBeNull();
  });

  it("reports the OLDEST type, so one type going stale goes red", async () => {
    ["venues", "events", "promoters"].forEach((t) => insert(t, 1_800_000_000));
    insert("vendors", 1_700_000_000);
    expect(await probe.lastEvidenceAt(db)).toEqual(new Date(1_700_000_000_000));
  });
});
