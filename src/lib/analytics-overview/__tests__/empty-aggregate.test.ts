/**
 * OPE-242 — FAM-EMPTY-COLLECTION empty-state coverage for the /admin/analytics
 * dashboard's aggregate card loaders.
 *
 * The founding case (OPE-58) was an admin page that rendered fine over N rows
 * and crashed the day its aggregate table was empty on cold-start. These assert
 * the opposite for three distinct aggregation shapes, each against an EMPTY
 * table (no rows inserted — the exact cold-start condition):
 *
 *   - loadTimeToIndex   — percentile sort + reduce-sum-divide (÷ n)
 *   - loadRecentErrors  — reduce-sum over grouped counts
 *   - loadThisWeeksActions — count() + row map
 *
 * Each must return a well-formed empty-state card and NEVER throw / yield
 * NaN / -Infinity. Uses the same in-memory better-sqlite3 + drizzle harness as
 * fault-health.test.ts (the other DB-backed loader tests). Tables are created
 * empty; we assert on the empty path specifically.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import type { Db } from "../shared";
import { loadTimeToIndex } from "../health";
import { loadRecentErrors } from "../health";
import { loadThisWeeksActions } from "../activity";

const SCHEMA_SQL = `
  CREATE TABLE time_to_index_log (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    indexnow_submitted_at INTEGER,
    first_crawl_at INTEGER,
    lag_seconds INTEGER,
    computed_at INTEGER
  );
  CREATE TABLE admin_actions (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    actor_user_id TEXT,
    target_type TEXT,
    target_id TEXT,
    payload_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE error_logs (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    level TEXT,
    message TEXT,
    context TEXT,
    url TEXT,
    method TEXT,
    status_code INTEGER,
    stack_trace TEXT,
    user_agent TEXT,
    source TEXT,
    route TEXT,
    digest TEXT
  );
`;

let db: Db;

beforeEach(() => {
  const sqlite = new Database(":memory:");
  sqlite.exec(SCHEMA_SQL);
  db = drizzle(sqlite, { schema }) as unknown as Db;
});

describe("OPE-242 — analytics card loaders on an EMPTY aggregate table", () => {
  it("loadTimeToIndex: no rows → null percentiles, no NaN, no throw (÷ n guarded)", async () => {
    const card = await loadTimeToIndex(db);
    expect(card.resolved).toBe(0);
    expect(card.unresolved).toBe(0);
    expect(card.median_seconds).toBeNull();
    expect(card.p90_seconds).toBeNull();
    expect(card.avg_seconds).toBeNull();
    // The ÷ n and reduce would produce NaN/-Infinity if the n===0 guard regressed.
    expect(Number.isNaN(card.avg_seconds as unknown as number)).toBe(false);
  });

  it("loadRecentErrors: no rows → zero total, empty topSources (reduce has init 0)", async () => {
    const card = await loadRecentErrors(db, new Date(0));
    expect(card.last24hCount).toBe(0);
    expect(card.topSources).toEqual([]);
  });

  it("loadThisWeeksActions: no rows → count 0, empty actions", async () => {
    const card = await loadThisWeeksActions(db, new Date(0));
    expect(card.count).toBe(0);
    expect(card.actions).toEqual([]);
  });
});
