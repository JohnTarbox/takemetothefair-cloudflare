/**
 * OPE-1325 — multi-edition series step 2/5: the migration's own guards.
 *
 * Applies the SHIPPED file (drizzle/0356) — not a copy of its DDL — to the
 * pre-0356 shape of the three tables it touches, then drives each guard to
 * failure: the edition_mode CHECK, the per-series unique edition key, and the
 * partial index's exemption for NULL keys on annual rows.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = readFileSync(
  join(__dirname, "..", "..", "..", "drizzle", "0356_ope1325_series_edition_mode.sql"),
  "utf8"
);

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  // Pre-0356 shape: only the columns the migration and these tests touch.
  db.exec(`
    CREATE TABLE event_series (id TEXT PRIMARY KEY, canonical_slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
    CREATE TABLE events (id TEXT PRIMARY KEY, slug TEXT NOT NULL, series_id TEXT);
    CREATE TABLE heartbeat_probes (probe_name TEXT PRIMARY KEY, enabled_at INTEGER, note TEXT, updated_at INTEGER);
    INSERT INTO event_series VALUES ('s1', 'near-fest', 'NEAR-Fest'), ('s2', 'big-e', 'The Big E');
    INSERT INTO events VALUES ('e1', 'near-fest-xl', 's1'), ('e2', 'near-fest-xli', 's1'), ('e3', 'big-e-2026', 's2');
  `);
  db.exec(MIGRATION);
});

describe("OPE-1325 — drizzle/0356 on existing rows", () => {
  it("every existing series reads 'annual' and every existing edition_key is NULL", () => {
    const modes = db.prepare("SELECT DISTINCT edition_mode FROM event_series").all();
    expect(modes).toEqual([{ edition_mode: "annual" }]);
    const keyed = db.prepare("SELECT count(*) n FROM events WHERE edition_key IS NOT NULL").get();
    const total = db.prepare("SELECT count(*) n FROM events").get();
    expect(keyed).toEqual({ n: 0 });
    expect(total).toEqual({ n: 3 }); // landmark: the zero above counted real rows
  });

  it("seeds the probe DORMANT", () => {
    expect(
      db
        .prepare("SELECT enabled_at FROM heartbeat_probes WHERE probe_name = 'series-edition-key'")
        .get()
    ).toEqual({ enabled_at: null });
  });
});

describe("OPE-1325 — guards, driven to failure", () => {
  it("the edition-key index is PARTIAL, so annual rows' NULL keys stay out of it", () => {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_events_series_edition_key'")
      .get() as { sql: string } | undefined;
    expect(row?.sql).toMatch(/^CREATE UNIQUE INDEX/);
    expect(row?.sql).toMatch(/WHERE edition_key IS NOT NULL/);
  });

  it("edition_mode accepts 'multi' and refuses anything else", () => {
    db.prepare("UPDATE event_series SET edition_mode = 'multi' WHERE id = 's1'").run();
    expect(() =>
      db.prepare("UPDATE event_series SET edition_mode = 'Multi' WHERE id = 's2'").run()
    ).toThrow(/CHECK constraint failed/);
  });

  it("refuses a second edition with the same key in the same series", () => {
    db.prepare("UPDATE events SET edition_key = '2026-10' WHERE id = 'e1'").run();
    expect(() =>
      db.prepare("UPDATE events SET edition_key = '2026-10' WHERE id = 'e2'").run()
    ).toThrow(/UNIQUE constraint failed/);
    // A different key in the same series is fine.
    db.prepare("UPDATE events SET edition_key = '2027-05' WHERE id = 'e2'").run();
  });

  it("allows the same key in a DIFFERENT series", () => {
    db.prepare("UPDATE events SET edition_key = '2026-10' WHERE id = 'e1'").run();
    db.prepare("UPDATE events SET edition_key = '2026-10' WHERE id = 'e3'").run();
  });

  it("leaves NULL keys unconstrained (every annual row shares a series and a NULL key)", () => {
    // SQLite semantics, not the partial index: NULLs are distinct in a UNIQUE
    // index. Mutation-checked — a full (non-partial) unique index also passes.
    db.prepare(
      "INSERT INTO events (id, slug, series_id) VALUES ('e4', 'near-fest-xlii', 's1')"
    ).run();
    const nulls = db
      .prepare("SELECT count(*) n FROM events WHERE series_id = 's1' AND edition_key IS NULL")
      .get();
    expect(nulls).toEqual({ n: 3 });
  });
});
