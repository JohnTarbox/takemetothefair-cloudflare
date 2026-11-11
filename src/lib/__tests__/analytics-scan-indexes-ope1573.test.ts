/**
 * OPE-1573 (drizzle/0415) — the three Overview-tab scans become index reads.
 *
 * Prod D1 has no sqlite_stat1, so a stats-free local plan is a fair proxy for
 * prod's plan. Each case asserts BOTH sides: the shape is a full SCAN without
 * the migration (so the test is not vacuous), and an index read with it.
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = readFileSync(
  join(import.meta.dirname, "../../../drizzle/0415_ope1573_analytics_scan_indexes.sql"),
  "utf8"
);

function freshDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE vendors (id TEXT PRIMARY KEY, enhanced_profile INTEGER NOT NULL DEFAULT 0,
      enhanced_profile_started_at INTEGER, deleted_at INTEGER, business_name TEXT);
    CREATE INDEX idx_vendors_deleted_at ON vendors(deleted_at);
    CREATE TABLE vendor_enrichment_candidates (id TEXT PRIMARY KEY, vendor_id TEXT,
      decision TEXT, job_run_id TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX idx_vec_vendor ON vendor_enrichment_candidates (vendor_id);
    CREATE INDEX idx_vec_decision ON vendor_enrichment_candidates (decision);
    CREATE TABLE health_issues (id TEXT PRIMARY KEY, source TEXT, first_detected_at INTEGER NOT NULL,
      last_detected_at INTEGER NOT NULL, resolved_at INTEGER);
    CREATE INDEX idx_health_issues_source ON health_issues (source, last_detected_at);
    CREATE INDEX idx_health_issues_open ON health_issues (resolved_at);
  `);
  return db;
}

// The SQL Drizzle emits for each Overview-tab read (from D1 query insights, 2026-11-11).
const CASES = [
  {
    name: "Enhanced Profile count by start window",
    sql: 'select count(*) from "vendors" where ("vendors"."enhanced_profile" = ? and "vendors"."enhanced_profile_started_at" >= ? and "vendors"."enhanced_profile_started_at" < ?)',
    params: [1, 1793201429, 1793806229],
    index: "idx_vendors_enhanced_profile_started",
  },
  {
    name: "newest vendor enrichment candidate",
    sql: 'select max("created_at") from "vendor_enrichment_candidates"',
    params: [],
    index: "idx_vec_created_at",
  },
  {
    name: "health issues detected since",
    sql: 'select count(*) from "health_issues" where "health_issues"."first_detected_at" >= ?',
    params: [1794324623],
    index: "idx_health_issues_first_detected",
  },
];

function plan(db: Database.Database, sql: string, params: unknown[]): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map((r) => r.detail)
    .join(" | ");
}

describe("drizzle/0415 — Overview-tab scans", () => {
  it("landmark: the migration declares one index per case", () => {
    for (const c of CASES) expect(MIGRATION).toContain(c.index);
  });

  for (const c of CASES) {
    it(`${c.name}: SCAN before, index read after`, () => {
      const db = freshDb();
      const before = plan(db, c.sql, c.params);
      expect(before).not.toContain(c.index);
      // No index at all. (SQLite labels an un-indexed max() "SEARCH t" even though
      // it reads every row — prod read ~7.2K rows a call — so the landmark is
      // the absence of USING INDEX, not the word SCAN.)
      expect(before).not.toMatch(/USING (COVERING )?INDEX/);

      db.exec(MIGRATION);
      const after = plan(db, c.sql, c.params);
      expect(after).toContain(c.index);
      // max() over an index is a single-row read SQLite reports as SEARCH.
      expect(after).not.toMatch(
        /\bSCAN vendors\b|\bSCAN vendor_enrichment_candidates\b|\bSCAN health_issues\b/
      );
    });
  }

  it("is idempotent and a no-op on an empty database", () => {
    const db = freshDb();
    db.exec(MIGRATION);
    expect(() => db.exec(MIGRATION)).not.toThrow();
  });
});
