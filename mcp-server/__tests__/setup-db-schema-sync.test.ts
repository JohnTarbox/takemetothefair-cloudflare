/**
 * WS2b (2026-06-11) — fail-loud guard against test-schema drift.
 *
 * The hand-maintained CREATE TABLE statements in setup-db.ts must stay in sync
 * with the Drizzle schema for the core entity tables. When a column is added to
 * the Drizzle schema but NOT to setup-db.ts, an mcp-server tool that writes it
 * fails at runtime with a SQLite "no column named X" — but only if a test
 * happens to exercise that write, so drift can hide for days (see the
 * 2026-06-05 EH1 incident).
 *
 * This guard makes that drift fail LOUD and deterministically: for each core
 * table it compares the real columns SQLite parsed from setup-db.ts's DDL
 * (PRAGMA table_info — no brittle regex) against the Drizzle schema's columns,
 * and fails listing any column present in the schema but missing from the test
 * DDL. Fix = add the column to the matching CREATE TABLE in setup-db.ts.
 *
 * Scope: the high-churn entity tables + their junctions. Lower-traffic tables
 * (sources, snapshots, etc.) are intentionally not guarded — setup-db.ts mirrors
 * only the columns their tools touch and that is fine.
 */
import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { createTestDb } from "./setup-db.js";
import * as schema from "../src/schema.js";

const CORE_TABLES = [
  "events",
  "vendors",
  "venues",
  "promoters",
  "event_vendors",
  "event_days",
  "inbound_emails",
  "admin_actions",
  "event_data_citations",
];

// SQL table name -> Drizzle column SQL names.
const schemaColumnsByTable: Record<string, string[]> = {};
for (const exported of Object.values(schema)) {
  let cfg;
  try {
    cfg = getTableConfig(exported as Parameters<typeof getTableConfig>[0]);
  } catch {
    continue; // not a table (enum, relation, helper, …)
  }
  schemaColumnsByTable[cfg.name] = cfg.columns.map((c) => c.name);
}

describe("setup-db schema sync (WS2b)", () => {
  const { raw } = createTestDb();

  it.each(CORE_TABLES)(
    "setup-db.ts CREATE TABLE %s covers every Drizzle schema column",
    (table) => {
      const schemaCols = schemaColumnsByTable[table];
      expect(schemaCols, `${table} is not a table in the Drizzle schema`).toBeDefined();

      const info = raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      const ddlCols = new Set(info.map((r) => r.name));
      expect(ddlCols.size, `${table} is missing from setup-db.ts SCHEMA_SQL`).toBeGreaterThan(0);

      const missing = schemaCols.filter((c) => !ddlCols.has(c));
      expect(
        missing,
        `setup-db.ts CREATE TABLE ${table} is missing column(s) added to the Drizzle ` +
          `schema: [${missing.join(", ")}]. Add them to the matching CREATE TABLE in ` +
          `mcp-server/__tests__/setup-db.ts, or mcp-server tools that write them will ` +
          `fail at runtime with "no column named X".`
      ).toEqual([]);
    }
  );
});
